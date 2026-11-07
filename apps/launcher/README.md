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
  "link_poll_max_seconds": 180,
  "autosave_minutes": 10
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
| `autosave_minutes`      | **Auto-guardado** del progreso en la nube cada X minutos (default **10**; **0 = desactivado**). Evita perder progreso si la PC muere a mitad de sesión: sube solo lo que cambió, respeta lo más nuevo y no consulta la API si nada cambió. Editable en Ajustes. |

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

## Auto-guardado periódico (contra pérdida de progreso)

Además del sync pre-lanzamiento y post-sesión, el launcher **auto-guarda el
progreso cada `autosave_minutes`** (default 10; 0 = desactivado; editable en
Ajustes: "Auto-guardar progreso cada X minutos"). Corre en un hilo de fondo
(nunca bloquea la UI) y **también mientras estás jugando**: si la PC muere a
mitad de sesión, se pierde como máximo lo de los últimos X minutos (el juego
hace flush del .stat a fin de ronda, así que lo subido es lo último flushed).

Reglas del tick (misma decisión de `decide_sync` que el resto del sync):

| Estado                                                    | Acción                                      | Log                                  |
| --------------------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| Local más nuevo que el server (o hash distinto / server vacío) | **Sube** con SHA-256 validado          | `Auto-guardado: progreso sincronizado ✓` |
| Idéntico al último manifiesto visto                       | **Nada** — ni consulta la API (caché)       | silencio                             |
| Server más nuevo (otra PC subió algo más reciente)        | **No sobrescribe** — se respeta al arrancar | `Auto-guardado omitido: el server tiene versión más nueva…` |
| Save ilegible (el juego lo está escribiendo a medias)     | **Salta el tick** y reintenta en el próximo | `autosave: archivo en escritura (…), reintentando en X min` |
| Sin login / `cloud_save` off / minutos = 0                | Nada                                        | silencio                             |

NUNCA hay dos subidas concurrentes (lock global `UPLOAD_LOCK` compartido con
el post-sesión y el cierre).

## Cerrar el launcher = detener el juego y guardar el progreso (SIEMPRE)

Si cierras la ventana del launcher mientras el juego que ÉL abrió sigue
corriendo, el launcher hace esto antes de cerrarse (sin toggle: siempre pasa):

1. La ventana desaparece al instante (feedback inmediato).
2. Mata el **árbol completo de procesos** del juego con
   `taskkill /PID <pid> /T /F`, usando el PID que el propio launcher lanzó
   (guardado al abrir el juego). **Nunca mata por nombre de proceso** — el
   server dedicado también se llama `iw4x.exe`, y un `taskkill /IM iw4x.exe`
   lo tumbaría; el launcher jamás toca procesos que no abrió él.
3. Espera a que el proceso esté realmente muerto (poll, máx. 5 s).
4. Sube el progreso de la sesión a tu cuenta (el mismo upload post-sesión de
   siempre, **una sola vez**, con presupuesto de ~10 s). Logs:
   `Launcher cerrado: juego detenido.` → `Progreso subido a tu cuenta ✓` →
   `Cerrando…`.
5. **Guardado final SIEMPRE**, tenga o no juego vivo: tras el paso anterior,
   el launcher intenta una última subida del estado local (misma decisión de
   siempre: solo sube si cambió respecto al server, presupuesto ~10 s). Así,
   si jugaste, cerraste el juego y dejaste el launcher abierto horas, el
   último estado igual llega a tu cuenta.
6. Si el juego ya se había cerrado solo, no hay kill ni doble upload: el
   flujo post-sesión normal hace la subida como siempre.

El mismo camino de cierre se garantiza por tres vías redundantes e
idempotentes: el botón X de la ventana (`WM_DELETE_WINDOW`), un
`try/finally` alrededor del mainloop y un hook `atexit`.

> **Limitación honesta:** si matas el launcher desde el Administrador de
> tareas (o se va la luz), el proceso no puede ejecutar su propia secuencia de
> cierre: en ese caso el juego sigue vivo y el upload de esa sesión no ocurre
> (se subirá en el próximo arranque si tu PC tiene lo más nuevo). Ningún
> programa puede salvarse de un kill externo.

## Tests

```bat
py apps\launcher\tests\run_all.py      # suite completa (units → smoke)
py apps\launcher\tests\test_units.py   # solo funciones puras (sin red, sin GUI)
py apps\launcher\tests\test_smoke.py   # solo E2E/GUI (requiere API :3000)
```

| Archivo              | Qué cubre |
| -------------------- | --------- |
| `tests/run_all.py`   | Runner: ejecuta **units primero** y **smoke después**; resumen por archivo (checks OK/fallidos, tiempo, exit del proceso) y exit != 0 si algo falla. |
| `tests/test_units.py`| Funciones **puras**, sin red ni GUI: `candidate_matches` / `pick_candidate` (nicks ^X, recencia), puras de `save_sync` (`local_save_files`, `sha256_of`, `decide_sync`, `build_upload_files` con caps, `detect_build`), `build_game_args` (+set name SIEMPRE), defaults/merge de `app_config`, `normalize_api_url` (esquema faltante, barra final, espacios, vacío → default; sin inventar puertos — incluye el caso real `127.0.0.1:5173`), `kill_tree` / `wait_process_exit` (taskkill `/PID /T /F` con stub de subprocess; fallos tragados) y el **autosave** (decisión de subida con stub, caché sin API, server más nuevo respetado, save ilegible → skip, config `autosave_minutes`). |
| `tests/test_smoke.py`| Suite **E2E/GUI** en vivo contra la API real y CustomTkinter: registro/login por NICK, auto-login por token, JUGAR + `+set name`, guard de nick, verificación de identidad automática, stats en vivo, cloud-sync (pipeline stub + E2E contra la API), 409s (`GUID_ALREADY_LINKED` / `USER_ALREADY_LINKED`), regresión visual del formulario y de la **franja CONEXIÓN del login** (URL visible + botón PROBAR antes del login), el **cierre del launcher** (kill tree del PID lanzado + upload único con stubs; sin juego vivo no toca nada) y el **autosave + guardado final al cerrar** (tick sube con cambios, sin cambios no consulta la API, cierre sin juego sube el último estado). |

Cuenta de prueba: `launcher-test@test.local` / `LauncherTest2026` (la crea el
propio smoke si la DB está limpia). NO es pytest: scripts secuenciales que
imprimen `[OK]/[FALLO]` por paso.
