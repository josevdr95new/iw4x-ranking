# IW4x Ranking — Launcher de escritorio (Python)

Launcher en Python para la web de ranking IW4x: login con cuentas (JWT),
vinculación cuenta ↔ GUID y arranque rápido del juego contra el server
elegido. GUI en **CustomTkinter** (tema oscuro, en español).

## Ejecutar (desarrollo)

```bat
py -m pip install -r apps\launcher\requirements.txt
py apps\launcher\main.py
```

## Compilar a un solo .exe

```bat
apps\launcher\build.bat      →  apps\launcher\dist\IW4xLauncher.exe
```

## Configuración externa (`launcher.config.json`)

El launcher NO tiene ajustes bloqueados tras el login: este archivo se lee al
arrancar y **se puede editar ANTES de iniciar sesión**. Además, la pantalla de
LOGIN tiene una franja `// CONEXIÓN //` (arriba del formulario) donde se ve la
API actual, se pulsa **PROBAR** (`GET /api/health`, timeout 3s) y se pulsa
**GUARDAR** — sin necesidad de editar el archivo a mano. Debajo de la franja
se muestra la ruta exacta del archivo de config.

### ¿Dónde está el archivo?

| Modo            | Ruta                                                        |
| --------------- | ----------------------------------------------------------- |
| Desarrollo      | `apps\launcher\launcher.config.json` (junto a `main.py`)     |
| .exe congelado  | **Junto al ejecutable**: `apps\launcher\dist\launcher.config.json` (al lado de `IW4xLauncher.exe`) |

### Ejemplo (valores por defecto si no existe)

```json
{
  "api_url": "http://192.168.3.99:3000",
  "game_path": "D:\\Call of Duty 6\\iw4x.exe",
  "servers": [
    { "name": "LAN Server", "address": "192.168.2.251:28960" },
    { "name": "Test Local", "address": "127.0.0.1:28961" }
  ],
  "default_server": 0,
  "simulate_game": false,
  "link_poll_interval": 10,
  "link_poll_max_seconds": 180
}
```

> **OJO con `api_url`:** apunta a la **API** (puerto **3000**), no a la web
> (puerto 5173). Un valor como `"127.0.0.1:5173"` deja el launcher sin poder
> entrar. Si escribes la IP sin esquema (`"127.0.0.1:3000"`), el launcher la
> normaliza solo a `http://127.0.0.1:3000` (nunca inventa ni cambia puertos).
> Con la API mal configurada, la franja CONEXIÓN del login queda en rojo
> (`● SIN CONEXIÓN — revisa la IP`) para que lo veas antes de intentar entrar.

| Clave                   | Significado                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `api_url`               | Base de la API (el launcher añade el prefijo `/api/...`). Editable **desde el login** (franja CONEXIÓN) y en Ajustes. |
| `game_path`             | Ruta de `iw4x.exe`. Editable en Ajustes (con selector).       |
| `servers`               | Lista de servers `{name, address}` para el dropdown.          |
| `default_server`        | Índice del server seleccionado al abrir. Editable en Ajustes. |
| `cloud_save`            | **true** por defecto: sincroniza el progreso (`players\iw4x.stat`, `iw4x_config.cfg`, `mods\<mod>\iw4x.stat`) con la cuenta antes de abrir el juego y al cerrarlo (backup automático previo en `%APPDATA%\iw4x-ranking-launcher\save-backups\`). Editable en Ajustes. |
| `simulate_game`         | **Flag de prueba**: simula el paso "abrir juego" sin lanzar el exe real (para probar el polling de vinculación contra la API). |
| `link_poll_interval`    | Segundos entre consultas de candidatos (default 10).          |
| `link_poll_max_seconds` | Tiempo máximo de espera de conexión (default 180 = 3 min).    |

## Datos por usuario

- Token JWT: `%APPDATA%\iw4x-ranking-launcher\token.json` (auto-login).
- Log rotativo: `%APPDATA%\iw4x-ranking-launcher\logs\launcher.log`.

## Flujo JUGAR

1. Si `/auth/me` indica cuenta sin `linkedGuid` → `POST /api/link/start`.
2. Lanza `iw4x.exe +set name <displayName> +connect <server>` (subprocess con
   lista de args, cwd = carpeta del juego). El nick del ranking es
   **OBLIGATORIO y SIEMPRE viaja** en el comando (`+set name`): los engines
   Q3 lo procesan tras cargar configs, así el displayName de la cuenta gana
   al nick guardado en el config del juego, sin tocar archivos. Si la
   cuenta no tiene displayName, el juego **no se lanza** y se pide
   actualizarlo en Mi Cuenta (web).
3. Polling de `POST /link/complete` (poll): se confirma automáticamente el
   candidato cuyo nick coincide con la cuenta (`pick_candidate` normaliza los
   códigos ^X y desambigua por recencia); si nadie coincide → espera y
   reintento hasta 3 min con aviso final por nick. Un `409 USER_ALREADY_LINKED`
   se trata como éxito; `GUID_ALREADY_LINKED` avisa de PC compartida.
4. Al confirmar: mensaje "Identidad verificada ✓" y refresco de `/auth/me`.
5. Cloud-sync del progreso (`cloud_save`, activado por defecto): antes de
   abrir el juego baja (o sube, si tu PC tiene lo más nuevo) `players\iw4x.stat`,
   `iw4x_config.cfg` y `mods\<mod>\iw4x.stat` con backup automático; al cerrar
   iw4x.exe sube el progreso de la sesión. Los errores de sync NUNCA impiden
   jugar.

## Tests

```bat
py apps\launcher\tests\run_all.py      # suite completa (units → smoke)
py apps\launcher\tests\test_units.py   # solo funciones puras (sin red, sin GUI)
py apps\launcher\tests\test_smoke.py   # solo E2E/GUI (requiere API :3000)
```

| Archivo              | Qué cubre |
| -------------------- | --------- |
| `tests/run_all.py`   | Runner: ejecuta **units primero** y **smoke después**; resumen por archivo (checks OK/fallidos, tiempo, exit del proceso) y exit != 0 si algo falla. |
| `tests/test_units.py`| Funciones **puras**, sin red ni GUI: `candidate_matches` / `pick_candidate` (nicks ^X, recencia), puras de `save_sync` (`local_save_files`, `sha256_of`, `decide_sync`, `build_upload_files` con caps, `detect_build`), `build_game_args` (+set name SIEMPRE), defaults/merge de `app_config` y `normalize_api_url` (esquema faltante, barra final, espacios, vacío → default; sin inventar puertos — incluye el caso real `127.0.0.1:5173`). |
| `tests/test_smoke.py`| Suite **E2E/GUI** en vivo contra la API real y CustomTkinter: registro/login por NICK, auto-login por token, JUGAR + `+set name`, guard de nick, verificación de identidad automática, stats en vivo, cloud-sync (pipeline stub + E2E contra la API), 409s (`GUID_ALREADY_LINKED` / `USER_ALREADY_LINKED`), regresión visual del formulario y de la **franja CONEXIÓN del login** (URL visible + botón PROBAR antes del login). |

Cuenta de prueba: `launcher-test@test.local` / `LauncherTest2026` (la crea el
propio smoke si la DB está limpia). NO es pytest: scripts secuenciales que
imprimen `[OK]/[FALLO]` por paso.
