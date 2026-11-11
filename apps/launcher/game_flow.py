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

AUTOCONEXIÓN DETERMINISTA (fix "conecta cuando quiere"): la build IW4x
(AlterWare r5318) procesa ``+connect`` del cmdline de forma INTERMITENTE
(carrera con la carga del juego): a veces conecta solo, a veces queda en
el MENÚ DE INICIO. Evidencia del dueño: su acceso directo
``iw4x.exe +connect ip:puerto`` funciona SIEMPRE — la carrera la abría el
``+set fs_game`` precargado (ya eliminado: el mod lo manda el server en el
handshake). Como red de seguridad, tras el Popen corre un HILO DAEMON con
dos fases: (1) ventana de gracia al cmdline verificando cada segundo por
``netstat`` si el juego YA abrió UDP hacia el server; (2) si no conectó,
inyección DETERMINISTA por la consola del juego (~ → ``connect ip:puerto``
tecleado por SendInput Unicode). Jamás toca widgets de Tk: usa el mismo
``emit`` (cola + ``after``) que el resto del flujo.
"""
from __future__ import annotations

import ctypes
import logging
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from api_client import ApiClient, ApiError, NetworkError
from app_config import normalize_server_address
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

    SIN ``+set fs_game`` (evidencia del dueño, 2026-11): su acceso directo
    ``iw4x.exe +connect ip:puerto`` conecta SIEMPRE; el ``+set fs_game
    mods/mp_bots`` que precargaba el launcher retrasaba el arranque (carga
    del mod) y abría la carrera con el ``+connect`` que a veces se perdía
    ("conecta cuando quiere"). El MOD lo manda el server en el handshake
    (método estándar, como con el acceso directo). La autoconexión por
    consola (``_autoconnect_worker``) queda como red de seguridad.

    ``+dumpPlayerData`` (export_classes, default True) va AL FINAL, después
    de ``+connect``: los ``+`` comandos se ejecutan en orden tras cargar las
    configs, así el dump de clases (customClasses → console_mp.log del
    cliente) corre con el playerdata ya inicializado. Al cerrar la sesión,
    el launcher lee ese log y sube las clases a la API (ver
    ``classes_export.export_player_classes``). Nota: como ya no se precarga
    fs_game, el cliente SIEMPRE escribe el console_mp.log del juego base —
    el dump funciona en todas las salas.
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


# ===========================================================================
# AUTOCONEXIÓN DETERMINISTA (red de seguridad del "+connect" intermitente)
# ===========================================================================
# La build IW4x (AlterWare r5318) procesa +connect del cmdline de forma
# intermitente. Tras lanzar el juego, un hilo daemon verifica por netstat
# si el proceso abrió UDP hacia el server; si no conectó dentro de la
# ventana de gracia, inyecta `connect ip:puerto` por la consola del juego.
# Las partes puras (is_connected / build_console_commands) son testeables
# y los primitivos de teclado viven en KeyboardInjector (stub-able).

# Puerto default del juego cuando el address llega sin ":puerto" (la
# convención de los defaults del config: Sala 1 = .251:28960).
DEFAULT_GAME_PORT = 28960

AUTOCONNECT_POLL_SECONDS = 1.0       # paso del chequeo (netstat cada 1s)
AUTOCONNECT_WINDOW_TIMEOUT = 30.0    # espera (s) por la ventana del juego
AUTOCONNECT_POST_VERIFY_WAIT = 10.0  # espera (s) antes de re-verificar
NETSTAT_TIMEOUT = 8.0                # techo del subprocess netstat -ano


def split_server_address(address: str) -> Optional[Tuple[str, int]]:
    """'host:puerto' (o host pelado) → (host, puerto) (pura).

    Reusa la validación del config (``normalize_server_address``) para el
    formato canónico; un address SIN puerto válido cae al puerto default
    del juego (``DEFAULT_GAME_PORT``) — misma convención que los defaults
    del config. Vacío/basura → ``None`` (el hilo de autoconexión aborta).
    """
    addr = str(address or "").strip()
    if not addr:
        return None
    normalized = normalize_server_address(addr)
    if normalized:
        host, _, port = normalized.rpartition(":")
        try:
            return host, int(port)
        except ValueError:  # defensivo: normalize garantiza dígitos
            return None
    host = addr.split("/", 1)[0].strip().strip("[]")
    if not host:
        return None
    return host, DEFAULT_GAME_PORT


# Caché host→IP del chequeo (un gethostbyname por hostname, no uno por
# segundo durante la ventana de gracia).
_HOST_IP_CACHE: Dict[str, str] = {}


def resolve_host_ip(host: str) -> str:
    """IP utilizable para matchear netstat (pura con caché de DNS).

    - IP literal v4 (``socket.inet_aton`` acepta) → tal cual (sin DNS).
    - Hostname → ``socket.gethostbyname`` (1 vez, caché); fallo → el host
      tal cual (el match por destino no encontrará, pero no lanza).
    """
    host = str(host or "").strip().strip("[]")
    if not host:
        return ""
    try:
        socket.inet_aton(host)
        return host  # IP literal: netstat la mostrará idéntica
    except OSError:
        pass
    cached = _HOST_IP_CACHE.get(host)
    if cached is not None:
        return cached
    try:
        ip = socket.gethostbyname(host)
    except OSError:
        return host  # sin DNS: se intenta con el host tal cual
    _HOST_IP_CACHE[host] = ip
    return ip


def _remote_matches(remote: str, target: str) -> bool:
    """¿El destino de netstat ES el target (o su forma IPv6-mapeada)? (pura)

    ``remote``/``target`` ya vienen en minúsculas y sin corchetes. El caso
    ``::ffff:192.168.2.251:28960`` (IPv4-mapeada en IPv6) matchea por
    sufijo solo si lo que precede al target termina en ':' — así un
    hipotético '1.192.168.2.251:28960' NO daría falso positivo.
    """
    if remote == target:
        return True
    if remote.endswith(target):
        prefix = remote[: -len(target)]
        return prefix.endswith(":")
    return False


def _netstat_addr(token: str) -> str:
    """Token de dirección de netstat → 'addr:puerto' sin corchetes (pura).

    ``[::ffff:1.2.3.4]:28960`` → ``::ffff:1.2.3.4:28960``; ``[::1]:1900``
    → ``::1:1900``; ``1.2.3.4:28960`` tal cual. (Un ``strip("[]")`` simple
    dejaría el ``]`` del medio: los corchetes solo rodean la dirección.)
    """
    token = str(token or "").strip()
    if "[" in token and "]" in token:
        head, _, tail = token.partition("]")
        return head.lstrip("[") + tail  # dirección limpia + ':puerto'
    return token.strip("[]")


def is_connected(netstat_output: str, pid: int, host: str, port: int) -> bool:
    """¿Hay una línea UDP de netstat de ESE pid hacia host:puerto? (pura)

    Formato de ``netstat -ano``: ``Proto  Local  Remote  [Estado]  PID`` —
    el PID es SIEMPRE el último token. SOLO cuenta UDP (el cliente habla
    con el server por UDP; una línea TCP no demuestra conexión de juego).
    ``host`` puede llegar como IP o hostname (se resuelve con
    ``resolve_host_ip``); las líneas IPv6 con corchetes (``[::]:28960``,
    ``[::ffff:1.2.3.4]:28960``) se parsean sin romper — la forma IPv4
    mapeada matchea por sufijo.
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        port = int(port)
    except (TypeError, ValueError):
        return False
    host_clean = str(host or "").strip().strip("[]").lower()
    if not host_clean:
        return False
    ip = resolve_host_ip(host_clean).lower()
    targets = {f"{ip}:{port}", f"{host_clean}:{port}"}
    for line in str(netstat_output or "").splitlines():
        tokens = line.split()
        if not tokens or tokens[0].upper() != "UDP":
            continue  # TCP/encabezados no cuentan
        try:
            line_pid = int(tokens[-1])
        except ValueError:
            continue  # línea de título (PID = 'PID'): no es una conexión
        if line_pid != pid or len(tokens) < 3:
            continue
        remote = _netstat_addr(tokens[2]).lower()
        for target in targets:
            if _remote_matches(remote, target):
                return True
    return False


def read_netstat_output() -> str:
    """Salida cruda de ``netstat -ano`` (hilos de fondo: subprocess).

    Cualquier fallo (netstat ausente, timeout, OSError) → ``""``: el
    chequeo de ese segundo no demuestra nada y la ventana sigue corriendo.
    """
    try:
        result = subprocess.run(
            ["netstat", "-ano"], capture_output=True,
            timeout=NETSTAT_TIMEOUT, check=False,
        )
    except Exception:  # OSError/Timeout: best-effort, jamás tumba el hilo
        return ""
    return result.stdout.decode("utf-8", errors="replace")


def build_console_commands(nick: str, ip: str, port: int) -> List[str]:
    """Comandos para la consola del juego, EN ORDEN (pura).

    - Con nick: ``name <nick>`` primero (el nick del ranking manda aunque
      el +set del cmdline lo hubiera perdido), luego ``connect ip:puerto``.
    - Sin nick: SOLO ``connect ip:puerto``. Cada comando va con su
      VK_RETURN (lo aplica ``send_console_sequence``, no esta función).
    """
    commands: List[str] = []
    name = str(nick or "").strip()
    if name:
        commands.append(f"name {name}")
    commands.append(f"connect {ip}:{port}")
    return commands


def send_console_sequence(injector: Any, hwnd: int, commands: List[str]) -> None:
    """Ejecuta la secuencia EXACTA de consola sobre un inyector (pura en
    orden: focus → abrir consola → (teclear + ENTER)* → cerrar consola).

    ``injector`` puede ser el KeyboardInjector real (ctypes) o el fake de
    los tests que graba la secuencia — los tests fijan así el contrato
    ``open→type(name)→enter→type(connect)→enter→close``.
    """
    injector.focus_window(hwnd)
    injector.open_console()
    for command in commands:
        injector.type_text(command)
        injector.press_enter()
    injector.close_console()


# --- Primitivas de teclado (ctypes user32; cero dependencias nuevas) -------
_VK_OEM_3 = 0xC0        # tecla ~ / backtick: abre y cierra la consola Q3
_VK_RETURN = 0x0D       # ENTER: ejecuta el comando tecleado
_KEYEVENTF_KEYUP = 0x0002
_KEYEVENTF_UNICODE = 0x0004
_INPUT_KEYBOARD = 1
_SW_RESTORE = 9

# Tipos EXACTOS de la API de Windows (x64: ULONG_PTR = 8 bytes → c_size_t).
_ULONG_PTR = ctypes.c_size_t


class _KEYBDINPUT(ctypes.Structure):
    """KEYBDINPUT real (winuser.h): WORD/WORD/DWORD/DWORD/ULONG_PTR."""
    _fields_ = [
        ("wVk", ctypes.c_ushort),        # WORD
        ("wScan", ctypes.c_ushort),      # WORD
        ("dwFlags", ctypes.c_ulong),     # DWORD
        ("time", ctypes.c_ulong),        # DWORD
        ("dwExtraInfo", _ULONG_PTR),     # ULONG_PTR
    ]


class _MOUSEINPUT(ctypes.Structure):
    """MOUSEINPUT real: el miembro MÁS GRANDE de la union de INPUT."""
    _fields_ = [
        ("dx", ctypes.c_long),           # LONG
        ("dy", ctypes.c_long),           # LONG
        ("mouseData", ctypes.c_ulong),   # DWORD
        ("dwFlags", ctypes.c_ulong),     # DWORD
        ("time", ctypes.c_ulong),        # DWORD
        ("dwExtraInfo", _ULONG_PTR),     # ULONG_PTR
    ]


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", ctypes.c_ulong),        # DWORD
        ("wParamL", ctypes.c_ushort),    # WORD
        ("wParamH", ctypes.c_ushort),    # WORD
    ]


class _INPUT_UNION(ctypes.Union):
    """Union de INPUT tal cual el header (mi, ki, hi): el tamaño de la
    estructura INPUT debe ser el del miembro mayor (MOUSEINPUT) o SendInput
    rechaza el buffer en x64."""
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT),
                ("hi", _HARDWAREINPUT)]


class _INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [
        ("type", ctypes.c_ulong),        # DWORD
        ("u", _INPUT_UNION),
    ]


def _utf16_code_units(text: str) -> List[int]:
    """Texto → unidades de código UTF-16 (pura): SendInput UNICODE teclea
    por unidad, así los caracteres fuera del BMP viajan como par
    suplente. Mitades suplentes sueltas se descartan (nada sensato).
    """
    units: List[int] = []
    for ch in str(text or ""):
        cp = ord(ch)
        if 0xD800 <= cp <= 0xDFFF:
            continue
        if cp <= 0xFFFF:
            units.append(cp)
        else:
            v = cp - 0x10000
            units.append(0xD800 + (v >> 10))
            units.append(0xDC00 + (v & 0x3FF))
    return units


class KeyboardInjector:
    """Primitivas de teclado reales para la consola del juego (ctypes).

    - ``open_console``/``close_console``: pulso VK_OEM_3 (~) con
      ``keybd_event`` (con sleeps de asentamiento del juego).
    - ``type_text``: SendInput con KEYEVENTF_UNICODE carácter a carácter —
      layout-INDEPENDIENTE (no importa que el teclado no sea US: la tecla ~
      del layout que sea abre la consola y el texto viaja como Unicode).
    - ``focus_window``: ShowWindow(SW_RESTORE) + SetForegroundWindow con
      fallback AttachThreadInput (el foreground desde un proceso de fondo
      está restringido por Windows).
    Todos los métodos son best-effort: cualquier fallo se loggea y el
    worker reporta el camino manual — jamás tumba el launcher.
    """

    def _user32(self) -> Optional[Any]:
        if os.name != "nt":
            return None
        try:
            return ctypes.windll.user32
        except Exception:  # pragma: no cover - solo entornos exóticos
            return None

    def _tap_vk(self, vk: int) -> None:
        """Pulso físico de una tecla virtual: down + up (keybd_event)."""
        user32 = self._user32()
        if user32 is None:
            return
        try:
            user32.keybd_event(vk, 0, 0, 0)
            user32.keybd_event(vk, 0, _KEYEVENTF_KEYUP, 0)
        except Exception:
            log.warning("keybd_event falló (vk=0x%02X)", vk, exc_info=True)

    def focus_window(self, hwnd: int) -> None:
        user32 = self._user32()
        if user32 is None or not hwnd:
            return
        try:
            user32.ShowWindow(hwnd, _SW_RESTORE)
            if not user32.SetForegroundWindow(hwnd):
                self._force_foreground(user32, hwnd)
        except Exception:
            log.warning("No se pudo enfocar la ventana del juego",
                        exc_info=True)
        time.sleep(0.8)  # asentar el focus antes de tocar la consola

    def _force_foreground(self, user32: Any, hwnd: int) -> None:
        """Fallback clásico de foreground: adjuntar el hilo de entrada de
        ESTE proceso al del foreground y al de la ventana del juego."""
        try:
            kernel32 = ctypes.windll.kernel32
            this_tid = kernel32.GetCurrentThreadId()
            fg_hwnd = user32.GetForegroundWindow()
            fg_tid = user32.GetWindowThreadProcessId(fg_hwnd, None)
            hwnd_tid = user32.GetWindowThreadProcessId(hwnd, None)
            user32.AttachThreadInput(this_tid, fg_tid, True)
            user32.AttachThreadInput(hwnd_tid, this_tid, True)
            user32.SetForegroundWindow(hwnd)
            user32.AttachThreadInput(hwnd_tid, this_tid, False)
            user32.AttachThreadInput(this_tid, fg_tid, False)
        except Exception:
            log.debug("AttachThreadInput falló (best-effort)", exc_info=True)

    def open_console(self) -> None:
        self._tap_vk(_VK_OEM_3)
        time.sleep(0.6)  # el juego abre el input de consola

    def close_console(self) -> None:
        time.sleep(0.6)  # dejar que el juego procese el último ENTER
        self._tap_vk(_VK_OEM_3)

    def press_enter(self) -> None:
        self._tap_vk(_VK_RETURN)

    def type_text(self, text: str) -> None:
        """Teclea texto layout-independiente (SendInput KEYEVENTF_UNICODE)."""
        user32 = self._user32()
        if user32 is None:
            return
        try:
            user32.SendInput.argtypes = [
                ctypes.c_uint, ctypes.POINTER(_INPUT), ctypes.c_int,
            ]
            user32.SendInput.restype = ctypes.c_uint
        except Exception:
            pass
        for unit in _utf16_code_units(text):
            for flags in (_KEYEVENTF_UNICODE,
                          _KEYEVENTF_UNICODE | _KEYEVENTF_KEYUP):
                event = _INPUT()
                event.type = _INPUT_KEYBOARD
                event.ki = _KEYBDINPUT(wVk=0, wScan=unit, dwFlags=flags,
                                       time=0, dwExtraInfo=0)
                try:
                    sent = user32.SendInput(1, ctypes.byref(event),
                                            ctypes.sizeof(_INPUT))
                except Exception:
                    log.warning("SendInput falló", exc_info=True)
                    return
                if sent != 1:
                    log.debug("SendInput rechazó la unidad U+%04X", unit)
            time.sleep(0.01)  # respiro entre caracteres (colas del juego)


def find_window_for_pid(pid: int) -> Optional[int]:
    """HWND de la ventana principal del pid (ctypes EnumWindows).

    Match: dueño == pid, ventana VISIBLE y con TÍTULO no vacío (la ventana
    del juego siempre tiene título; descarta ventanas mensajería/sombra).
    Stub-able en tests (fake devuelve hwnd falso o None). Fallo o sin
    ventana → ``None``.
    """
    if os.name != "nt":
        return None
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    try:
        user32 = ctypes.windll.user32
    except Exception:  # pragma: no cover - solo entornos exóticos
        return None
    enum_proc = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p,
                                   ctypes.c_void_p)
    found: List[int] = []

    def _on_window(hwnd, _lparam) -> int:
        try:
            owner = ctypes.c_ulong(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value == pid and user32.IsWindowVisible(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buf, length + 1)
                    if buf.value.strip():
                        found.append(hwnd)
                        return 0  # basta la primera: detener enumeración
        except Exception:  # una ventana rara no aborta la enumeración
            log.debug("EnumWindows callback falló", exc_info=True)
        return 1  # continuar

    try:
        user32.EnumWindows(enum_proc(_on_window), ctypes.c_void_p(0))
    except Exception:
        log.warning("EnumWindows falló buscando la ventana del juego",
                    exc_info=True)
        return None
    return found[0] if found else None


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
        autoconnect: bool = False,
        autoconnect_wait_seconds: int = 20,
        netstat_fn: Optional[Callable[[], str]] = None,
        find_window_fn: Optional[Callable[[int], Optional[int]]] = None,
        injector: Optional[Any] = None,
        sleep_fn: Optional[Callable[[float], None]] = None,
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

        # AUTOCONEXIÓN determinista (red de seguridad del +connect
        # intermitente). El default del CONTRUCTOR es False (los tests
        # viejos conservan el comportamiento antiguo); la UI pasa el valor
        # del config (``autoconnect: True`` en DEFAULT_CONFIG). El hilo NO
        # arranca con autoconnect=False o simulate=True. Primitivos
        # INYECTABLES para tests: netstat, buscador de ventana, inyector de
        # teclado y sleeper (jamás tocar netstat/teclado real en pruebas).
        self.autoconnect = bool(autoconnect)
        try:
            self.autoconnect_wait_seconds = max(0, int(autoconnect_wait_seconds))
        except (TypeError, ValueError):
            self.autoconnect_wait_seconds = 20
        self._netstat_fn = netstat_fn or read_netstat_output
        self._find_window_fn = find_window_fn or find_window_for_pid
        self._injector = injector  # None → KeyboardInjector() real en fase 2
        self._sleep = sleep_fn or time.sleep
        self._autoconnect_thread: Optional[threading.Thread] = None

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
            # Red de seguridad: hilo daemon que verifica la conexión y, si
            # la build perdió el +connect, inyecta `connect` por la consola.
            self._maybe_start_autoconnect()
            return True
        except OSError as exc:
            self._failed(f"No se pudo abrir el juego: {exc}", retry=True)
            self._maybe_restore_quarantined_files()
            self._maybe_upload_classes()
            return False

    # --- Autoconexión determinista ------------------------------------------
    def _maybe_start_autoconnect(self) -> Optional[threading.Thread]:
        """Arranca el hilo daemon de autoconexión (si aplica).

        NO arranca con ``autoconnect=False`` o ``simulate=True``
        (comportamiento antiguo) ni sin proceso de juego real. Idempotente:
        un solo hilo por flujo.
        """
        if not self.autoconnect or self.simulate or self._process is None:
            return None
        if self._autoconnect_thread is not None:
            return self._autoconnect_thread
        self._autoconnect_thread = threading.Thread(
            target=self._autoconnect_worker, daemon=True, name="autoconnect",
        )
        self._autoconnect_thread.start()
        return self._autoconnect_thread

    def _autoconnect_worker(self) -> None:
        """Cuerpo del hilo daemon de autoconexión (dos fases).

        FASE 1 — gracia al cmdline: la build normalmente honra el
        ``+connect`` (el acceso directo del dueño funciona SIEMPRE); se le
        da una ventana de ``autoconnect_wait_seconds`` verificando cada
        segundo por netstat si el proceso del juego ya abrió UDP hacia el
        server. Si conectó → log y FIN (cero disturbio). Si el juego murió
        → aborto silencioso.

        FASE 2 — inyección por consola (camino garantizado): enfoca la
        ventana del juego, abre la consola (~), teclea ``name <nick>`` y
        ``connect ip:puerto`` con SendInput Unicode y cierra. A los 10s
        re-verifica por netstat y reporta el resultado (sin reintentos: el
        dueño está mirando).

        NUNCA toca widgets de Tk: los logs van por el mismo ``emit`` (cola
        + ``after``) que el resto del flujo. Jamás lanza: cualquier error
        se loggea y degrada al mensaje manual.
        """
        pid = self.game_pid()
        parsed = split_server_address(self.server_address)
        if not pid or parsed is None:
            return
        host, port = parsed
        endpoint = f"{host}:{port}"

        # --- FASE 1: gracia al +connect del cmdline -------------------------
        for _ in range(self.autoconnect_wait_seconds):
            if not self.game_running() or self._cancelled.is_set():
                return  # juego muerto / launcher cerrando: aborto en silencio
            try:
                output = self._netstat_fn()
                if output and is_connected(output, pid, host, port):
                    self._log("Conectado al server.")
                    return  # el cmdline ganó: no se toca nada
            except Exception:
                log.exception("Chequeo de conexión (netstat) falló")
            self._sleep(AUTOCONNECT_POLL_SECONDS)
        if not self.game_running() or self._cancelled.is_set():
            return

        # --- FASE 2: inyección por la consola del juego ---------------------
        self._log(f"Autoconectando a {endpoint}… (el juego no conectó solo)")
        hwnd = None
        polls = max(1, int(AUTOCONNECT_WINDOW_TIMEOUT / AUTOCONNECT_POLL_SECONDS))
        for _ in range(polls):
            try:
                hwnd = self._find_window_fn(pid)
            except Exception:
                log.exception("Búsqueda de la ventana del juego falló")
                hwnd = None
            if hwnd:
                break
            if not self.game_running() or self._cancelled.is_set():
                return
            self._sleep(AUTOCONNECT_POLL_SECONDS)
        if not hwnd:
            self._log(f"No encontré la ventana del juego — conecta manual "
                      f"(~): connect {endpoint}")
            return
        commands = build_console_commands(self.display_name, host, port)
        injector = self._injector if self._injector is not None \
            else KeyboardInjector()
        try:
            send_console_sequence(injector, hwnd, commands)
        except Exception:
            log.exception("Inyección de la consola falló")
            self._log(f"No pude escribir en la consola — conecta manual "
                      f"(~): connect {endpoint}")
            return
        self._log("Comandos enviados a la consola del juego.")

        # --- Verificación post-inyección (UNA sola; sin reintentos) ---------
        self._sleep(AUTOCONNECT_POST_VERIFY_WAIT)
        if not self.game_running() or self._cancelled.is_set():
            return
        try:
            output = self._netstat_fn()
            connected = bool(output) and is_connected(output, pid, host, port)
        except Exception:
            log.exception("Verificación post-inyección falló")
            connected = False
        if connected:
            self._log("Conectado al server.")
        else:
            self._log("Aún sin conexión — revisa que el server esté arriba "
                      f"o conecta manual (~): connect {endpoint}")

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
