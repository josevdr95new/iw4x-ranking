"""Estado REAL de los servers de juego: API del backend + fallback TCP/Q3.

Pedido del dueño (FUENTE APROBADA): la disponibilidad real por sala sale del
endpoint público del backend ``GET {api_url}/api/salas`` — el backend en
producción corre EN el LXC junto a las salas y consulta por RCON (datos
reales de jugadores/bots/mapa). Cada server del config se MATCHREA por
address (host:puerto) para mostrar el estado de ESA sala.

Fallback (documentado): ``configured:false``, lista de salas vacía o API
caída → se vuelve al chequeo directo TCP + UDP getstatus (protocolo Q3,
``ÿÿÿÿgetstatus``): TCP connect 2 s — el dedicado IW4x escucha TCP (netstat
real: ``TCP 0.0.0.0:28961 LISTENING``); OK = ONLINE. UN datagrama UDP
(timeout 1.5 s) con ``statusResponse`` aporta ``\players\<N>\`` → "ONLINE ·
N jugadores". NADA → OFFLINE.

Server NO presente en la respuesta del API → estado DESCONOCIDO (dim, sin
inventar datos).

Todo corre en hilos de fondo (``App.run_bg``): jamás bloquea la UI de Tk.
Este módulo es importable SIN GUI (no toca customtkinter): las partes puras
se testean en tests/test_units.py y el probe real (sockets loopback) en
tests/test_smoke.py.

Guard: ``simulate_game`` NO afecta — esto es estado del server real,
independiente del flag de simulación del juego.
"""
from __future__ import annotations

import json
import re
import socket
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from app_config import normalize_api_url, normalize_server_address

# Timeouts del contrato (breves: el chequeo NUNCA se siente en la UI).
DEFAULT_TCP_TIMEOUT = 2.0
DEFAULT_UDP_TIMEOUT = 1.5
DEFAULT_SALAS_TIMEOUT = 3.0

# Estados canónicos del chequeo (los que pinta el dot de la UI).
STATE_CHECKING = "checking"  # ámbar: verificando…
STATE_ONLINE = "online"      # verde: ● EN LÍNEA / ● ONLINE
STATE_OFFLINE = "offline"    # gris/dim: ● OFFLINE
STATE_UNKNOWN = "unknown"    # gris/dim: ● SIN DATOS (API no lo lista)

SOURCE_API = "api"  # estado desde GET /api/salas (RCON real del backend)
SOURCE_TCP = "tcp"  # estado desde el chequeo directo (fallback)

# Datagrama de query estilo Quake 3 (4 bytes 0xFF + comando).
_GETSTATUS = b"\xff\xff\xff\xffgetstatus"
# Prefijo de la respuesta esperada (mismo magic + "statusResponse").
_STATUS_RESPONSE = b"\xff\xff\xff\xffstatusResponse"

# Infostring: pares \\clave\\valor. El contador de jugadores puede venir
# como `players` (IW4x) o `clients` (builds Q3/MW2). El valor corre hasta
# el siguiente `\` o fin de línea/string (no siempre hay `\` de cierre).
_PLAYERS_RE = re.compile(rb"\\(?:players|clients)\\(\d{1,4})(?:\\|\r?\n|\x00|$)")


@dataclass(frozen=True)
class ServerStatus:
    """Resultado del chequeo: estado + datos de la sala (si los hay)."""

    state: str
    players: Optional[int] = None
    source: str = SOURCE_TCP      # "api" (RCON del backend) | "tcp" (directo)
    map_name: Optional[str] = None    # ej. "mp_terminal" (crudo del API)
    bots: Optional[int] = None
    max_clients: Optional[int] = None
    sala_name: Optional[str] = None   # nombre del backend (ej. "CTHolguin Sala 1")


# ===========================================================================
# FUENTE APROBADA: GET {api_url}/api/salas (puras + un fetch para hilos bg)
# ===========================================================================

def parse_salas_response(payload: Any) -> List[Dict[str, Any]]:
    """Normaliza la respuesta de ``/api/salas`` (pura).

    Contrato: ``{"configured": true, "salas": [{id, name, address, online,
    hostname, map, players, bots, maxClients}, ...]}``.

    Devuelve salas limpias ``[{address, online, players, bots, max_clients,
    map, name}, ...]``. ``configured:false``, ``salas`` ausente/vacía,
    entradas sin address o JSON no-dict → ``[]`` (la UI hace FALLBACK al
    chequeo TCP directo: jamás se inventa un estado).
    """
    if not isinstance(payload, dict):
        return []
    if payload.get("configured") is not True:
        return []
    raw = payload.get("salas")
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        address = str(item.get("address") or "").strip()
        if not address:
            continue  # sala sin address: inusable para matchear
        out.append({
            "address": address,
            "online": bool(item.get("online")),
            "players": _as_int(item.get("players")),
            "bots": _as_int(item.get("bots")),
            "max_clients": _as_int(item.get("maxClients")),
            "map": str(item.get("map") or "").strip() or None,
            "name": str(item.get("name") or "").strip() or None,
        })
    return out


def _as_int(value: Any) -> Optional[int]:
    """int tolerante (None/str vacía/basura → None; jamás inventa)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def address_key(address: str) -> str:
    """Clave canónica de match por address: 'host:puerto' en minúsculas.

    Tolera espacios y mayúsculas distintas entre el config y el backend.
    Address sin puerto válido → clave solo-host (el match la usa SOLO si
    hay exactamente UNA sala de ese host: sin ambigüedad, sin inventar).
    Address inválida → ``""``.
    """
    addr = str(address or "").strip().lower()
    if not addr:
        return ""
    normalized = normalize_server_address(addr)
    if normalized:
        return normalized.lower()
    # Sin puerto: devolvemos el host pelado (match único de host, abajo).
    host = addr.split("/", 1)[0].strip()
    return host if host else ""


def match_sala(salas: List[Dict[str, Any]], address: str
               ) -> Optional[Dict[str, Any]]:
    """Encuentra la sala del backend para un server del config (pura).

    1. Match EXACTO por 'host:puerto' (normalizado).
    2. Sin exacto: si el config trae puerto y EXISTE una sola sala del
       mismo host SIN puerto en su address, esa es (formato distinto del
       backend). Con DOS o más salas de ese host sin puerto → ``None``
       (ambiguo: no se adivina).
    3. Nada → ``None`` (la UI pinta DESCONOCIDO: sin inventar).
    """
    key = address_key(address)
    if not key:
        return None
    for sala in salas:
        if address_key(sala.get("address") or "") == key:
            return sala
    host_only = ":" not in key
    config_host = key
    if not host_only:
        config_host = key.rsplit(":", 1)[0]
        config_port = key.rsplit(":", 1)[1]
        # El exacto ya falló; solo tiene sentido buscar salas SIN puerto.
        candidates = [
            s for s in salas
            if (address_key(s.get("address") or "")
                == config_host)  # clave solo-host = sala sin puerto
        ]
        if len(candidates) == 1:
            return candidates[0]
        return None
    return None


def sala_to_status(sala: Optional[Dict[str, Any]]) -> Optional[ServerStatus]:
    """Sala del backend → ServerStatus (pura). ``None`` → ``None``.

    Acepta el dict CRUDO del contrato (``maxClients`` camelCase) o el
    normalizado por ``parse_salas_response`` (``max_clients``).
    """
    if sala is None:
        return None
    online = bool(sala.get("online"))
    max_clients = sala.get("max_clients")
    if max_clients is None:
        max_clients = _as_int(sala.get("maxClients"))
    return ServerStatus(
        state=STATE_ONLINE if online else STATE_OFFLINE,
        players=sala.get("players"),
        source=SOURCE_API,
        map_name=sala.get("map"),
        bots=sala.get("bots"),
        max_clients=max_clients,
        sala_name=sala.get("name"),
    )


def fetch_salas(api_url: str,
                timeout: float = DEFAULT_SALAS_TIMEOUT) -> List[Dict[str, Any]]:
    """GET ``{api_url}/api/salas`` (SOLO hilos de fondo: red + parse).

    Cualquier fallo (API caída, 404 mientras el backend despliega, JSON
    roto, timeout) → ``[]``: la UI hace FALLBACK al chequeo TCP directo.
    Nunca lanza.
    """
    base = normalize_api_url(api_url, default="")
    if not base:
        return []
    try:
        with urllib.request.urlopen(
                f"{base}/api/salas", timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
        return parse_salas_response(payload)
    except Exception:
        return []


# ===========================================================================
# FALLBACK: chequeo directo TCP + UDP getstatus (protocolo Q3)
# ===========================================================================

def split_address(address: str) -> Optional[Tuple[str, int]]:
    """'host:puerto' → (host, puerto) para el probe (pura).

    Reusa la validación del config (``normalize_server_address``: formato
    host:puerto, puerto 1024-65535) para que lo chequeado sea EXACTAMENTE
    lo que se puede guardar/jugar. Inválida → ``None`` (la UI no pinta
    estado para basura).
    """
    addr = normalize_server_address(address)
    if not addr:
        return None
    host, _, port = addr.rpartition(":")
    return host, int(port)


def parse_status_response(data: bytes) -> Optional[int]:
    """Parsea ``\\players\\<N>\\`` de una respuesta getstatus Q3 (pura).

    Devuelve el número de jugadores conectados, o ``None`` si el payload
    no es un ``statusResponse`` válido o no trae contador (basura → sin
    jugadores: la sala sigue ONLINE por TCP, solo sin cifra).
    """
    payload = bytes(data or b"")
    if not payload.startswith(_STATUS_RESPONSE):
        return None
    match = _PLAYERS_RE.search(payload)
    if match is None:
        return None
    try:
        return int(match.group(1))
    except ValueError:  # no puede pasar con \d+, defensivo
        return None


def probe_server(address: str,
                 tcp_timeout: float = DEFAULT_TCP_TIMEOUT,
                 udp_timeout: float = DEFAULT_UDP_TIMEOUT
                 ) -> Optional[ServerStatus]:
    """Chequea un server REAL: TCP primero, UDP getstatus de bonus.

    - Dirección inválida → ``None`` (la UI no muestra estado).
    - TCP falla (refusado/timeout/unreachable) → OFFLINE.
    - TCP OK + UDP ``statusResponse`` con contador → ONLINE · N jugadores.
    - TCP OK + UDP sin respuesta (muchos servers filtran o NAT) → ONLINE
      sin cifra (el servidor ESCUCHA: eso ya es disponibilidad real).
    Pensado para correr en un hilo de fondo: solo sockets, sin Tk.
    """
    parsed = split_address(address)
    if parsed is None:
        return None
    host, port = parsed

    # 1) TCP connect: ¿algo ESCUCHA en host:puerto?
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(tcp_timeout)
    try:
        sock.connect((host, port))
    except OSError:
        return ServerStatus(state=STATE_OFFLINE, players=None)
    finally:
        try:
            sock.close()  # solo era el ping de disponibilidad
        except OSError:
            pass

    # 2) BONUS: UN datagrama getstatus para saber los jugadores.
    players = None
    try:
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.settimeout(udp_timeout)
        try:
            udp.sendto(_GETSTATUS, (host, port))
            data, _addr = udp.recvfrom(2048)
            players = parse_status_response(data)  # None si basura
        finally:
            udp.close()
    except (OSError, socket.timeout):
        players = None  # sin respuesta UDP: ONLINE igual (TCP OK)

    return ServerStatus(state=STATE_ONLINE, players=players)


# ===========================================================================
# Pintado (puras): copy HUD aprobado + color del dot + label del dropdown
# ===========================================================================

def pretty_map(map_name: Optional[str]) -> Optional[str]:
    """'mp_terminal' → 'Terminal' (pura). Vacío/desconocido → ``None``."""
    name = str(map_name or "").strip()
    if not name:
        return None
    if name.lower().startswith("mp_"):
        name = name[3:]
    name = name.replace("_", " ").strip()
    if not name:
        return None
    return name[0].upper() + name[1:]


def format_status_text(status: Optional[ServerStatus]) -> str:
    """Texto HUD del estado (pura).

    - API online:    'EN LÍNEA · mapa: Terminal · 2/18 · 2 humanos · 14 bots'
    - API online sin datos: 'EN LÍNEA'
    - TCP online:    'ONLINE · 6 jugadores' / 'ONLINE'
    - offline:       'OFFLINE'   ·   desconocido: 'SIN DATOS'
    - verificando:   'verificando…'   ·   None (fila inválida): ''
    """
    if status is None:
        return ""
    if status.state == STATE_CHECKING:
        return "verificando…"
    if status.state == STATE_OFFLINE:
        return "OFFLINE"
    if status.state == STATE_UNKNOWN:
        return "SIN DATOS"
    if status.state != STATE_ONLINE:
        return ""
    if status.source == SOURCE_API:
        parts = ["EN LÍNEA"]
        mapa = pretty_map(status.map_name)
        if mapa:
            parts.append(f"mapa: {mapa}")
        if status.players is not None and status.max_clients:
            parts.append(f"{status.players}/{status.max_clients}")
        elif status.players is not None:
            word = "jugador" if status.players == 1 else "jugadores"
            parts.append(f"{status.players} {word}")
        if status.players is not None and status.bots is not None:
            h_word = "humano" if status.players == 1 else "humanos"
            b_word = "bot" if status.bots == 1 else "bots"
            parts.append(f"{status.players} {h_word} · {status.bots} {b_word}")
        return " · ".join(parts)
    # Fuente directa (fallback TCP): copy clásico.
    if status.players is None:
        return "ONLINE"
    word = "jugador" if status.players == 1 else "jugadores"
    return f"ONLINE · {status.players} {word}"


def status_color_key(status: Optional[ServerStatus]) -> str:
    """Clave de color del dot (pura): 'ok' | 'accent' | 'dim' (de theme)."""
    if status is None:
        return "dim"  # sin dirección válida: nada que verificar
    if status.state == STATE_ONLINE:
        return "ok"        # verde señal #8FD429: SOLO OK/verificado
    if status.state == STATE_CHECKING:
        return "accent"    # ámbar: verificando… (familia del acento)
    return "dim"           # offline y desconocido: gris apagado (NUNCA rojo)


def sala_dropdown_label(name: str, address: str,
                        status: Optional[ServerStatus]) -> str:
    """Label del dropdown de la HOME (pura).

    WARNING informativo del dueño: la sala SELECCIONADA/default offline
    según el API → '● Sala 1 — OFFLINE' (JUGAR NUNCA se bloquea: solo
    informativo). OFFLINE detectado solo por TCP (fallback, señal débil —
    el server puede filtrar el probe) NO decora: label canónico. El resto:
    'Nombre  (host:puerto)' (dos espacios, el formato de siempre).
    """
    if (status is not None and status.state == STATE_OFFLINE
            and status.source == SOURCE_API):
        return f"● {name} — OFFLINE"
    return f"{name}  ({address})"
