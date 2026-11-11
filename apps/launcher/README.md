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
LOGIN tiene una franja `// CONEXIÓN //` (arriba del formulario, **colapsable**:
la caption es clickeable y tras el primer éxito de conexión se colapsa sola)
donde se ve la API actual, se pulsa **PROBAR** (`GET /api/health`, timeout 3s)
y se pulsa **GUARDAR** — sin necesidad de editar el archivo a mano. Debajo de
la franja se muestra la ruta exacta del archivo de config. El login es
**compacto**: la columna completa (CONEXIÓN + campos + botones + enlace
"Crear cuenta") cabe en la ventana mínima (980x640) sin maximizar; en
pantallas muy bajas aparece una scrollbar vertical (también con la rueda del
ratón).

### ¿Dónde está el archivo?

| Modo            | Ruta                                                        |
| --------------- | ----------------------------------------------------------- |
| Desarrollo      | `apps\launcher\launcher.config.json` (junto a `main.py`)     |
| .exe congelado  | **Junto al ejecutable**: `apps\launcher\dist\launcher.config.json` (al lado de `IW4xLauncher.exe`) |

### Ejemplo (valores por defecto si no existe)

Los defaults del código (`DEFAULT_CONFIG` en `app_config.py`) son los de
**PRODUCCIÓN** (el LXC): API en `:3000`, web en `:4173` y las DOS salas de
juego + Local (Sala 1 primero). Para **desarrollo local** sobreescribe
`api_url` y `web_url` en tu `launcher.config.json` (Vite dev corre en 5173):

```json
{
  "api_url": "http://192.168.2.251:3000",
  "web_url": "http://192.168.2.251:4173",
  "game_path": "D:\\Call of Duty 6\\iw4x.exe",
  "servers": [
    { "name": "Sala 1",  "address": "192.168.2.251:28960" },
    { "name": "Sala 2",  "address": "192.168.2.251:28961" },
    { "name": "Local",   "address": "127.0.0.1:28961" }
  ],
  "default_server": 0,
  "simulate_game": false,
  "export_classes": true,
  "autosave_minutes": 10
}
```

### Producción (LXC Debian 12 en Proxmox — 192.168.2.251)

El **config de distribución** (`dist\launcher.config.json`, el que se entrega
JUNTO al `IW4xLauncher.exe`) apunta al mismo LXC de producción — y los
defaults del exe coinciden, así que una instalación sin config también
arranca bien. En el LXC corren la API ranking (:3000), la web (:4173) y DOS
salas de juego (:28960 y :28961):

```json
{
  "api_url": "http://192.168.2.251:3000",
  "web_url": "http://192.168.2.251:4173",
  "game_path": "D:\\Call of Duty 6\\iw4x.exe",
  "servers": [
    { "name": "Sala 1", "address": "192.168.2.251:28960" },
    { "name": "Sala 2", "address": "192.168.2.251:28961" },
    { "name": "Local",  "address": "127.0.0.1:28961" }
  ],
  "default_server": 0,
  "simulate_game": false,
  "cloud_save": true,
  "export_classes": true,
  "autosave_minutes": 10,
  "remember_session": false
}
```

> La web de PRODUCCIÓN corre en el puerto **4173** (preview de Vite), no en
> el 5173 del dev: el default se deriva del `api_url` con ese puerto, y el
> config de distribución además fija `web_url` explícito. El launcher lee
> este archivo EN CADA ARRANQUE (runtime): cambiar el config NO requiere
> rebuild — pero sí **cerrar y volver a abrir** el launcher (uno abierto
> conserva la config que cargó al arrancar).

> **OJO con `api_url`:** apunta a la **API** (puerto **3000**), no a la web
> (puerto 4173). Un valor como `"127.0.0.1:4173"` deja el launcher sin poder
> entrar. Si escribes la IP sin esquema (`"127.0.0.1:3000"`), el launcher la
> normaliza solo a `http://127.0.0.1:3000` (nunca inventa ni cambia puertos).
> Con la API mal configurada, la franja CONEXIÓN del login queda en rojo
> (`● SIN CONEXIÓN — revisa la IP`) para que lo veas antes de intentar entrar.

| Clave                   | Significado                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `api_url`               | Base de la API (el launcher añade el prefijo `/api/...`). Editable **desde el login** (franja CONEXIÓN) y en Ajustes. |
| `web_url`               | Web del ranking que se abre en el navegador con los enlaces **RANKING WEB ↗** (login) y **WEB ↗** (cabecera de la home). Default **derivado del `api_url`**: mismo host, puerto **4173** (la web en el LXC) — p. ej. `http://192.168.2.251:3000` → `http://192.168.2.251:4173`. Si la web vive en otro host/puerto, escríbelo aquí (se normaliza: añade `http://` y recorta la barra final, nunca inventa puertos). Un valor **vacío (`""`) oculta los dos enlaces**. Para desarrollo local (Vite dev en 5173) sobreescribe `api_url` y `web_url` en tu `launcher.config.json`. |
| `game_path`             | Ruta de `iw4x.exe`. Editable en Ajustes (con selector).       |
| `servers`               | Lista de servers `{name, address}` para el dropdown.          |
| `default_server`        | Índice del server seleccionado al abrir. Editable en Ajustes. |
| `cloud_save`            | **true** por defecto: sincroniza el progreso (`players\iw4x.stat`, `iw4x_config.cfg`, `mods\<mod>\iw4x.stat`) con la cuenta antes de abrir el juego y al cerrarlo (backup automático previo en `%APPDATA%\iw4x-ranking-launcher\save-backups\`). Editable en Ajustes. |
| `export_classes`        | **true** por defecto: al arrancar el juego el launcher inyecta el comando nativo **`+dumpPlayerData`** (después de `+connect`) y al cerrarlo lee el `console_mp.log` del CLIENTE, extrae el dump de clases (sección `customClasses`) y lo sube a la API → las 15 clases aparecen en tu perfil web sin pasos manuales. Editable en Ajustes ("Exportar mis clases al perfil web (se genera al arrancar el juego)"). Ver [Clases de loadout al perfil web](#clases-de-loadout-al-perfil-web-sin-pasos-manuales). |
| `simulate_game`         | **Flag de prueba**: simula el paso "abrir juego" sin lanzar el exe real (para probar el flujo JUGAR contra la API). |
| `remember_session`      | **false** por defecto (cyber-café): al **CERRAR** el launcher se **borra el token guardado** (log `Sesión cerrada. Hasta la próxima.`) y al **ABRIR** aparece el **LOGIN** — cada quien hace su propio login, nadie hereda sesiones. `true` = auto-login con el token como siempre. Editable en Ajustes ("Mantener mi sesión abierta al cerrar el launcher"). |
| `autosave_minutes`      | **Auto-guardado** del progreso en la nube cada X minutos (default **10**; **0 = desactivado**). Evita perder progreso si la PC muere a mitad de sesión: sube solo lo que cambió, respeta lo más nuevo y no consulta la API si nada cambió. Editable en Ajustes. |

> Las claves viejas `link_poll_interval` / `link_poll_max_seconds` quedaron
> obsoletas (el polling de candidatos se eliminó: la identidad la vincula el
> server solo) y se purgan del config al cargar.

## Datos por usuario

- Token JWT: `%APPDATA%\iw4x-ranking-launcher\token.json` (auto-login).
- Log rotativo: `%APPDATA%\iw4x-ranking-launcher\logs\launcher.log`.

## Panel de stats en vivo (`// TUS STATS //`)

La home pinta el perfil del GUID vinculado (`GET /api/players/:guid`,
refresco cada 30 s o con el botón ↻). El grid muestra RANK · LVL · KILLS ·
DEATHS · HEADSHOTS · K/D · MEDALLA (medallón del tier + su nombre; la medalla
la decide la API desde el ELO y viaja en la raíz de la respuesta). La línea
de detalle añade el tiempo jugado, el último server, el jugador, el ratio de
headshots (`HS 15% de bajas`), el **ELO** del perfil (`ELO 1375` — el mismo
número que decide la medalla) y el balance de cuchillo (`CUCHILLO 11/0`,
bajas/muertes por cuchillo, como en la web). `ULT. SERVER` es el último
server donde se registraron tus stats (viene del perfil, guardado en los
eventos) — NO el server seleccionado en el dropdown. Cualquier dato que aún
no llegue se pinta como `—` sin romper el panel; en tiers 1-7 el detalle
muestra las estrellas ★/☆ del progreso y en tier 8 `LEYENDA #N · TOP 12` en
ámbar.

## Estado REAL de los servers (● ONLINE / OFFLINE, pedido del dueño)

La lista de **SERVERS DE JUEGO** en Ajustes muestra la disponibilidad REAL de
cada sala en vivo: `Sala 1 (192.168.2.251:28960) · ● ONLINE · 6 jugadores`.
Junto al dropdown de la HOME pasa lo mismo con el server SELECCIONADO.

- **● ONLINE** (verde señal `ok` #8FD429) + jugadores conectados si se puede
  saber; **● OFFLINE** (gris/dim — nunca rojo: no es un error del launcher);
  **● verificando…** (ámbar) mientras corre el chequeo.
- Heurística simple y determinista (`server_status.py`):
  1. **TCP connect** al host:puerto (timeout 2 s): el dedicado IW4x escucha
     TCP (verificado con netstat: `TCP 0.0.0.0:28961 LISTENING`). Conecta =
     ONLINE.
  2. **BONUS jugadores**: UN datagrama UDP `ÿÿÿÿgetstatus` al mismo
     host:puerto (protocolo Q3, timeout 1.5 s). Si responde
     `statusResponse` se parsea `\players\<N>\` del infostring (fallback
     `\clients\<N>\`, el nombre clásico Q3/MW2) → "ONLINE · N jugadores".
     Sin respuesta UDP pero TCP OK → ONLINE sin cifra. NADA → OFFLINE.
- Todo corre en **hilos de fondo** (jamás bloquea la UI), los N servers se
  verifican EN PARALELO y el refresco es: al abrir Ajustes + botón
  **ACTUALIZAR ESTADO** + cada 30 s mientras Ajustes (o la HOME) esté
  visible. Dirección inválida/fila vacía → sin estado (nada que verificar).
- Guard: `simulate_game` NO afecta — esto es estado del server real,
  independiente del flag de simulación del juego.

## Flujo JUGAR (simplificado: sin pantalla de verificación)

Orden del arranque (decisión del dueño) — **sin check previo del server**:
si el server está caído, el juego simplemente abre y falla al conectar
dentro del juego.

`Paso 1/2: Cargando tu progreso…` → verificación → `Todo cargado ✓` →
`Paso 2/2: Abriendo juego…`

1. Al dar JUGAR el launcher abre/renueva la **sesión de juego**
   (`POST /api/play/session`, best-effort: un fallo se ignora con log dim y
   NUNCA bloquea jugar). La renueva cada 30s mientras hay sesión iniciada.
   Con esa sesión activa, el **SERVER auto-vincula la identidad** cuando el
   jugador entra — no hay espera de candidatos ni pantalla de verificación en
   la UI: el launcher se queda en la home/stats normal y los logs de la
   consola sustituyen a la pantalla ("Juego iniciado con tu nick. Tu
   identidad se vincula automáticamente al entrar al server."). Si a los ~60s
   de juego la cuenta sigue sin identidad, aparece UN log dim único
   ("Aún sin vincular: se vinculará automáticamente…").
2. **PASO 1/2 — Cargar el save**: aislamiento de identidad por cuenta (fix
   cyber-café): en el pre-launch (SIEMPRE con el juego cerrado), si el
   manifiesto de la cuenta NO tiene `guid.dat` pero la PC SÍ tiene uno local
   (de otro jugador), el local se **cuarentena** en
   `%APPDATA%\iw4x-ranking-launcher\guid-quarantine\<userId>-<ts>\guid.dat`
   y el juego crea una identidad NUEVA y propia que el upload post-sesión
   sube a ESTA cuenta (log: `Identidad nueva creada para tu cuenta (primera
   vez en esta PC)`). Si la sesión muere antes de crear identidad (<10s sin
   guid nuevo), el cuarentenado se repone. Si el manifiesto ya trae
   `guid.dat`, el sync lo restaura como siempre; ante un fallo de red se
   conserva la identidad local sin tocar nada. Cloud-sync del progreso
   (`cloud_save`, activado por defecto): baja (o sube, si tu PC tiene lo
   más nuevo) `players\iw4x.stat`, `iw4x_config.cfg`, `mods\<mod>\iw4x.stat`
   y el `guid.dat` de identidad con backup automático. Los errores de sync
   NUNCA impiden jugar.
3. **Verificación del restore** (`Verificando que se cargó todo…`): cada
   archivo que la nube de la cuenta tiene debe quedar en disco con contenido
   real (`iw4x.stat` ≥ 100 B · `guid.dat` ≥ 64 B · configs ≥ 10 B). Si falta
   algo, se reintenta el restore UNA vez; si sigue fallando, WARNING
   `No se pudo verificar todo tu progreso — se continúa igual (no perder la
   partida)` y se continúa — jugar jamás se bloquea por sync.
4. **PASO 2/2 — Ejecutar**: lanza
   `iw4x.exe +set name <displayName> +connect <server> +dumpPlayerData`
   (subprocess con lista de args, cwd = carpeta del juego). El nick del
   ranking es **OBLIGATORIO y SIEMPRE viaja** en el comando (`+set name`): los
   engines Q3 lo procesan tras cargar configs, así el displayName de la cuenta
   gana al nick guardado en el config del juego, sin tocar archivos. Si la
   cuenta no tiene displayName, el juego **no se lanza** y se pide
   actualizarlo en Mi Cuenta (web). Con `export_classes` activo (default), el
   `+dumpPlayerData` va AL FINAL para que el dump de clases corra con el
   playerdata ya inicializado (ver la sección de clases).
5. El botón héroe pasa a **DETENER** mientras el juego (que este launcher
   abrió) siga vivo; al cerrarse el juego solo, vuelve a JUGAR. Los stats
   siguen refrescando cada 30s como siempre. Al cerrar iw4x.exe sube el
   progreso de la sesión.

## CERRAR SESIÓN guarda el progreso

Al pulsar **CERRAR SESIÓN** (pedido del dueño) el launcher sincroniza los
saves ANTES de borrar el token: log `Guardando tu progreso antes de cerrar
sesión…` → `Progreso guardado ✓` (o `Tu progreso ya está en la nube ✓` si no
hay nada que subir; presupuesto ~10s, el mismo tick final del cierre). Si la
API está caída: `No se pudo guardar (sin conexión) — cerrando sesión
igualmente` y prosigue (resiliente). Con una **partida en curso** el logout
NO procede: warning `Tienes una partida en curso: termina y cierra el juego
antes de cerrar sesión.` + aviso 5s en la barra de estado — el post-sesión
conserva el token para subir el save cuando el juego se cierre. Tras guardar,
el logout existente sigue igual (borrado del token si `remember_session`
es false y vuelta a LOGIN).

## Clases de loadout al perfil web (sin pasos manuales)

Con `export_classes` (default **true**, checkbox *"Exportar mis clases al
perfil web (se genera al arrancar el juego)"* en Ajustes) las 15 clases del
jugador llegan a su perfil web SIN pasos manuales:

1. **Arranque**: el launcher añade `+dumpPlayerData` al FINAL del comando
   (igual que `+unlockstats` y `+connect`): el cliente imprime el árbol DDL
   de clases (sección `customClasses`) en su `console_mp.log`.
2. **Cierre del juego**: el launcher localiza el log del CLIENTE, comprueba
   si el dump cambió desde la última subida (hash SHA-256 persistido en
   `%APPDATA%\iw4x-ranking-launcher\classes-export.json`) y sube los últimos
   800k caracteres del log a `POST /api/players/classes` con el JWT de la
   cuenta. Log de éxito: `Clases exportadas a tu perfil web ✓`.

**Ubicación del log del cliente** (hallazgo real en la PC del dueño, por
mtimes y cabecera de cada archivo):

| Archivo                                     | Qué es                                                      | ¿Se usa? |
| ------------------------------------------- | ------------------------------------------------------------ | -------- |
| `<game>\main\console_mp.log`                | **CLIENTE** — lo escribe el cliente al arrancar sin `fs_game` (cabecera con el comando vacío, sin `-dedicated`). Ahí cae el dump. | ✅ |
| `<game>\console_mp.log`                     | Candidato normativo (raíz); hoy no existe en esta build, se escanea por si aparece. | ✅ |
| `%LOCALAPPDATA%\iw4x\console_mp.log`        | Candidato normativo (homepath de cliente); hoy no existe, se escanea. | ✅ |
| `<game>\userraw\console_mp.log`             | **SERVER dedicado** (cabecera `-dedicated`): jamás se usa aunque sea el más reciente. | ❌ |
| `<game>\mods\<mod>\console_mp.log`          | Servers dedicados con mod (también `-dedicated`).            | ❌ |

La regla de detección (clase `classes_export.find_client_dump_log`): un
candidato vale SOLO si su texto contiene la sección `customClasses` con
contenido real (`name = "`, `_deathstreak`, `weaponSetups`, `specialGrenade`)
y su cabecera NO es de server (`-dedicated`); de los válidos gana el de mtime
más reciente.

Filosofía cloud-sync: la subida es **best-effort** — un error de la API es un
WARNING sin bloquear (`⚠ Exportación de clases omitida: …`), la API caída es
un skip silencioso (solo al archivo de log) y nunca se impide jugar ni
cerrar. Si la sesión muere antes de tiempo pero el dump ya quedó escrito, la
subida se intenta igual tras el fallo de arranque.

### Fallback manual (si el dump no se generara solo)

Si alguna build del juego no escribiera el log o el dump no apareciera, el
paso manual sigue disponible y el launcher lo detecta igual: abre la consola
del juego (`~`), ejecuta `/dumpPlayerData`, y el launcher subirá el dump del
`console_mp.log` en su próxima revisión post-sesión (mismo hash/cambio). Si
el log quedara en una ruta no listada arriba, se puede añadir a mano
editando `classes_export.candidate_log_paths` (la detección es la misma:
sección con contenido real y cabecera de cliente).

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
| `tests/test_units.py`| Funciones **puras**, sin red ni GUI: puras de `save_sync` (`local_save_files`, `sha256_of`, `decide_sync`, `build_upload_files` con caps, `detect_build`), aislamiento de identidad (`decide_guid_action` restore/quarantine/none + manifest None, `quarantine_local_guid` con rutas inyectadas), `build_game_args` (+set name SIEMPRE), defaults/merge de `app_config`, `normalize_api_url` (esquema faltante, barra final, espacios, vacío → default; sin inventar puertos — incluye el caso real `127.0.0.1:5173`), **`server_status`** (parser `\players\<N>\` del `statusResponse` Q3 con fixture real + fallback `\clients\`, basura → sin cifra; `split_address` reusando la validación del config; texto `ONLINE · N jugadores`/`OFFLINE`/`verificando…`; clave de color ok/dim/accent), `kill_tree` / `wait_process_exit` (taskkill `/PID /T /F` con stub de subprocess; fallos tragados) y el **autosave** (decisión de subida con stub, caché sin API, server más nuevo respetado, save ilegible → skip, config `autosave_minutes`). |
| `tests/test_smoke.py`| Suite **E2E/GUI** en vivo contra la API real y CustomTkinter: registro/login por NICK, auto-login por token, JUGAR simplificado (sin polling: log de auto-link, sesión de juego `POST /api/play/session` con stub + aviso dim único), pipeline de cuarentena guid.dat → identidad nueva → upload (y restauración de seguridad <10s), stats en vivo, cloud-sync (pipeline stub + E2E contra la API), contrato `/api/play/session` contra la API real (404 → PENDIENTE mientras el backend despliega), **login compacto** (ENTRAR y CREAR CUENTA dentro del viewport en 980x640, franja CONEXIÓN colapsable, Canvas+Scrollbar con rueda en pantallas bajas), regresión visual del formulario, el **cierre del launcher** (kill tree del PID lanzado + upload único con stubs; sin juego vivo no toca nada), el **autosave + guardado final al cerrar** y el **estado REAL de servers** (server TCP falso en puerto efímero + respondedor UDP getstatus → `● ONLINE · 3 jugadores` verde; TCP sin UDP → ONLINE sin cifra; puerto cerrado → `● OFFLINE` dim; pintado en Ajustes/HOME sin bloquear la UI con timeouts acotados). |

Cuenta de prueba: `launcher-test@test.local` / `LauncherTest2026` (la crea el
propio smoke si la DB está limpia). NO es pytest: scripts secuenciales que
imprimen `[OK]/[FALLO]` por paso.
