# SETUP — IW4x Ranking

Guía de instalación, configuración y ejecución (Windows / PowerShell, pero los comandos funcionan igual en bash cambiando `Copy-Item` por `cp`).

## Requisitos

- **Node.js ≥ 20** (verificado con Node 24) y **npm ≥ 10**
- Git (para el repo)

## 1. Instalar

```powershell
cd iw4x-ranking
npm install
```

`npm install` instala los workspaces (`apps/api`) y corre `prisma generate` automáticamente.

## 2. Configurar variables de entorno

Copia el ejemplo y edítalo:

```powershell
Copy-Item .env.example apps/api/.env
```

Variables (todas en `apps/api/.env`; la API también lee un `.env` en la raíz del repo como fallback):

| Variable               | Obligatoria | Descripción |
| ---------------------- | ----------- | ----------- |
| `PORT`                 | no (3000)   | Puerto HTTP de la API |
| `NODE_ENV`             | no (development) | `development` / `test` / `production` |
| `DATABASE_URL`         | no (`file:./dev.db`) | SQLite propia. Las rutas relativas se resuelven contra `apps/api/prisma/` |
| `JWT_SECRET`           | **sí en producción** | Secreto de firma JWT (≥16 chars). En dev, si falta, se usa un secreto efímero con warning |
| `JWT_EXPIRES_IN`       | no (`7d`)   | Expiración del token (formato jsonwebtoken: `12h`, `7d`, …) |
| `IW4MADMIN_DB_PATH`    | para sync por DB | Ruta a la SQLite de IW4MAdmin. Se abre **SIEMPRE read-only**. Alternativa: `GAME_LOG_PATH` |
| `GAME_LOG_PATH`        | para sync por log | Ruta del `games_mp.log` del server dedicado IW4x (ver [Ingesta por log](#ingesta-por-log-del-server-dedicado)). Soporta rutas UNC (`\\servidor\share\games_mp.log`); usa comillas simples en `.env` para UNC |
| `GAME_SERVER_ADDRESS`  | no          | Dirección guardada como servidor de los eventos (ej. `192.168.3.99:28961`) |
| `SYNC_INTERVAL_MINUTES`| no (0)      | `> 0` activa sync automática cada N minutos |
| `SYNC_INTERVAL_SECONDS`| no (0)      | Tiene **prioridad** sobre los minutos (ej. `30` = ingest casi en vivo) |
| `LINK_WINDOW_MINUTES`  | no (10)     | Ventana para candidatos de vinculación GUID |
| `CORS_ORIGIN`          | no (`http://localhost:5173`) | Orígenes CORS, separados por coma |

> ⚠️ **Paths en Windows**: usa **barras normales** (`C:/IW4MAdmin/Database/Database.sqlite`). dotenv interpreta secuencias como `\n` dentro de comillas dobles y rompería `C:\temp\new\...`.

## 3. Crear el esquema de la base propia

```powershell
npm run db:push     # crea apps/api/prisma/dev.db según prisma/schema.prisma
```

## 4A. Datos demo (sin servidores reales)

```powershell
npm run mock:db     # genera Database/Database.sqlite (esquema IW4MAdmin simulado)
npm run sync        # sincroniza mock → dev.db
npm run dev:api     # levanta la API en http://localhost:3000
```

El mock genera **50 jugadores** con nombres realistas estilo MW2, **~9000 kill events** repartidos en **10 servidores** y 8 jugadores con conexión reciente (para probar la vinculación GUID de inmediato). Es determinista (seed fija) y acepta `--out <ruta>`:

```powershell
npm run mock:db -- --out C:/temp/mi-mock.sqlite
```

> ℹ️ **Estado actual de `dev.db`**: contiene SOLO datos reales ingestados del games_mp.log local. Para volver a demos: descomenta `IW4MADMIN_DB_PATH` en `apps/api/.env`, corre `npm run mock:db` (regenera `Database/Database.sqlite`), luego `prisma db push --force-reset` + `npm run sync` (el sync combina ambas fuentes si ambas están configuradas).

> ⚠️ Si **regeneras** el mock, borra también `apps/api/prisma/dev.db` y repite `db:push` + `sync`: el cursor incremental de kill events (`SyncState`) asume una fuente que solo crece.

### Refrescar candidatos de vinculación (demo/E2E)

Si ya pasó la ventana de 10 minutos y `POST /api/link/complete` devuelve 0 candidatos, refresca la última conexión de 3 jugadores en la mock y re-sincroniza:

```powershell
npm run mock:refresh-connections   #LastConnection = hace ~2 min para 3 jugadores al azar
npm run sync
```

Acepta `--count N`, `--minutes N`, `--exclude guid1,guid2` (útil para excluir GUIDs ya vinculados) y `--db <ruta>`.

Smoke test end-to-end (con el server corriendo y datos sincronizados):

```powershell
npm run smoke       # 14 checks: auth, sync, leaderboard, perfil, historial, vinculación
```

## 4B. Servidor dedicado local de pruebas (configs oficiales AlterWare)

El entorno real de pruebas usa las **configs oficiales** de [IW4ServerConfigs](https://git.alterware.dev/alterware/IW4ServerConfigs) (guía oficial: [IW4x Server Install Guide](https://forum.alterware.dev/t/iw4x-server-install-guide-windows/241)).

Instalación (una sola vez):

1. Descarga el paquete: `https://git.alterware.dev/alterware/IW4ServerConfigs/archive/main.zip`
2. Descomprime el contenido de la carpeta `iw4serverconfigs` en la raíz del juego (ej. `D:\Call of Duty 6\`): trae los bats `DedicatedServer*.bat`, `partyserver*.cfg`, playlists y `userraw\server.cfg` + `userraw\serverlan.cfg`.
3. Edita `DedicatedServer.bat` con tus valores:
   - `set GamePort=28961`
   - `set LANMode=1` (no aparece en la lista pública; los clientes entran por IP)
   - `set LogFile=2`
   - **Importante**: el bat trae `start /W alterware-launcher.exe --update`. Déjalo comentado/elimínalo: actualizar el juego con el server corriendo puede corromper archivos. Corre `alterware-launcher.exe --update` solo cuando **NADA** del juego esté abierto.
4. Edita `userraw\server.cfg` (estructura oficial) y aplica SIEMPRE estos requisitos del ranking:
   - `set logfile "2"` + `set g_log "logs/games_mp.log"` (crítico: es el log que parsea la API)
   - `set g_logSync "1"`
   - `set sv_hostname "^7[^1RANKING^7] ^7Local Test Server"` (prefijo [RANKING])
   - `set g_gametype "war"` y rotación con `addGametype war` + `addMap` (5 mapas stock: `mp_rust`, `mp_terminal`, `mp_highrise`, `mp_cross_fire` —ese es el nombre oficial en IW4x—, `mp_strike`)
   - `set scr_testclients "4"` (el dvar existe en la build r5318; ver nota de bots abajo)
   - `set rcon_password "<valor aleatorio>"`

Arranque:

```powershell
& "D:\Call of Duty 6\DedicatedServer.bat"   # desde la raíz del juego
```

Verificación: proceso `iw4x` vivo, puerto UDP 28961 escuchando (`Get-NetUDPEndpoint -LocalPort 28961`) y el log creciendo en `D:\Call of Duty 6\userraw\logs\games_mp.log` (ruta oficial de `g_log`; el juego APRENDE líneas entre partidas, no trunca el archivo salvo que se borre manualmente).

**Nota bots**: `scr_testclients` es reconocido por la build (la consola imprime `Getting bots...`) pero en la práctica los bots NO se conectan a la partida (verificado en varias rotaciones). La actividad de stats requiere jugadores humanos reales.

**Conectarse desde el cliente IW4x** (consola con ñ/tecla asignada, o menú):

```
connect 127.0.0.1:28961        ; desde ESTE mismo PC
connect 192.168.3.99:28961     ; desde cualquier PC de la LAN (esta máquina es 192.168.3.99)
```

> El server real de la comunidad está en `192.168.2.251:28960` (otra máquina y otra subred). Ese server NO se administra desde este PC: solo es ingestable vía [modo log remoto](#modo-log-remoto-server-192168225128960).

## 4C. Ingesta por log (del server dedicado)

Alternativa (y hoy fuente principal) al reader de IW4MAdmin: la API lee **directamente el `games_mp.log`** que escribe el server dedicado. Configura en `apps/api/.env`:

```ini
GAME_LOG_PATH=D:/Call of Duty 6/userraw/logs/games_mp.log
GAME_SERVER_ADDRESS=192.168.3.99:28961
SYNC_INTERVAL_SECONDS=30     # ingest casi en vivo
```

- El sync **combina** las fuentes configuradas: `IW4MADMIN_DB_PATH` (si existe) + `GAME_LOG_PATH` (si existe). Si no hay ninguna → `503 SYNC_NOT_CONFIGURED`.
- Formato parseado (⚠️ **víctima-primero** en ESTA build — verificado con scoreboard en vivo; el stock IW4 es al revés):
  - `J;<guid hex>;<clientnum>;<nombre>` → conexión (abre una **Session**; incrementa `connections`)
  - `Q;<guid hex>;<clientnum>;<nombre>` → desconexión (cierra la Session)
  - `K;<vguid>;<vcid>;<vteam>;<vname>;<kguid>;<kcid>;<kteam>;<kname>;<weapon>;<dmg>;<mod>;<hitloc>` → kill: el **PRIMER bloque es la VÍCTIMA** y el **SEGUNDO el KILLER** (el `team` va ANTES del `name` en ambos; en kills "world" el killer tiene guid vacío y kteam=`world`, nunca al revés). En la DB se guarda `originGuid`=KILLER, `targetGuid`=VÍCTIMA. Si una build futura cambia esto, repetir el experimento del scoreboard (ver docs/API.md) antes de tocar el parser.
  - `D;...` (mismo layout) → daño no letal: NO se almacena como evento (bloat), solo alimenta `damageDealt` (killer/2º bloque) y `damageTaken` (víctima/1er bloque)
  - `InitGame: \map\mp_rust\g_gametype\war\...` → estado mapa/modo que se etiqueta en cada evento (si la línea va sin infostring —como en la build actual— quedan `null`)
  - `ShutdownGame:` → cierra todas las sesiones abiertas
- GUIDs hex de 16 chars se convierten a **decimal BigInt** (`b94be6deca6c750c` → `13371660518428851948`) para coincidir con el esquema `Player` (NetworkId decimal). Los bots (`botN`) se mapean al rango dedicado `0xb07…` y pueden aparecer en cualquiera de los dos bloques.
- El lector es **incremental por offset de bytes** (`LogIngestState`): cada línea se aplica exactamente una vez; tolera escrituras a medias (la última línea sin `\n` se procesa en el ciclo siguiente) y detecta truncados/rotaciones (reinicia el offset).
- Derivados por jugador: `headshots` (hitloc head/helmet, acreditadas al KILLER), `damageDealt`/`damageTaken`, `bestStreak` (kills consecutivas sin muerte; aproximación), `teamkills`, `matchesPlayed` (mapas distintos), `timePlayed` (suma de sesiones; abiertas = en curso con cap de 4h).
- **Defensivo**: líneas no reconocidas → skip silencioso + contador (visible en `warnings` del sync); GUIDs corruptos → evento descartado + contador. Nunca rompe el sync.

#### RECUENTO del histórico (`npm run recount:stats`)

Recalcula TODO el histórico desde el log con el parser vigente. **Cuándo usarlo**: tras cambiar la semántica del parser (ej. el fix víctima-primero de esta build), tras corregir bugs de conteo, o cuando los agregados de `Player` queden inconsistentes con los `KillEvent`. Qué hace: backup de `dev.db` (`prisma/backups/dev.db.recount-<timestamp>` vía `VACUUM INTO`) → borra derivados del log (`KillEvent`, `Session`, `PlayerAlias`, `Player` sin cuenta vinculada; counters a 0 de los vinculados — NUNCA toca `User`/`Penalty`/`IdentityAlert`/cloud-saves) → rewirea el cursor `LogIngestState` a 0 → re-ingesta el archivo entero → recalcula el skill ELO from scratch → VERIFICA los counters contra la verdad parseada del propio log (detecta y reintenta si el scheduler del dev:api ingirió en paralelo).

```powershell
npm run recount:stats          # recuento real (con backup previo)
npm run recount:stats -- --dry # NO borra nada: solo imprime el plan
```

> ⚠️ Ejecutar idealmente con el server VACÍO: si la partida está en curso, el scheduler del dev:api puede ingestar en paralelo durante el wipe+reingesta. El script lo detecta (verificación absoluta contra el log) y reintenta solo, pero la corrida limpia es la garantía. `npm run recompute:skill` sigue existiendo para recalcular SOLO el ELO sin tocar stats.

#### RESET vs RECUENTO vs LIMPIEZA (`db:zero` / `recount:stats` / `db:clean`)

| Comando | Qué hace | Cuándo usarlo |
| ------- | -------- | ------------- |
| `npm run db:zero` | **RESET TOTAL de datos de juego**: borra `KillEvent`, `Session`, `PlayerAlias`, `Player` (todos), `Penalty`, `IdentityAlert`, `LinkAttempt` y `SyncRun`; fija el cursor del log al **EOF actual** → el histórico del `games_mp.log` queda **IGNORADO** y solo cuentan las líneas NUEVAS. **Conserva**: `User` (cuentas), `AccountLink` (vínculos guid↔cuenta; quedan colgando y se curan solos cuando el guid reaparece), `SyncState`, cloud-saves y configuración. Backup previo (`dev.db.zero-<timestamp>`). `--dry` soportado. El skill no requiere recompute: los players nacen de nuevo con ELO 1000. | Empezar el conteo **desde cero** para la próxima partida (ideal con server y API apagados). NO re-cuenta nada del histórico. |
| `npm run recount:stats` | **RE-CUENTA el histórico completo** del `games_mp.log` con el parser vigente: rewinda el cursor a 0, re-ingesta TODO el archivo, recalcula el skill ELO from scratch y verifica los counters contra el log (con reintento). Conserva `User`, `AccountLink` y los players vinculados (counters a 0 y re-poblados). Backup previo. `--dry` soportado. | Tras cambiar la semántica del parser (ej. fix víctima-primero) o cuando los agregados de `Player` quedan inconsistentes con los `KillEvent`. MANTIENE el histórico del log como fuente. |
| `npm run db:clean` | **Limpieza QUIRÚRGICA e idempotente** de datos de prueba conocidos: guids TESTPROBE específicos, usuarios `*.test.local`, sus dependientes y storage huérfano. NUNCA toca players reales, bots, partidas ni el admin por defecto. | Borrar artefactos de un probe/prueba concreta SIN resetear el resto de los datos. |


## 4D. Modo log remoto (server 192.168.2.251:28960)

Para ingestar stats del **server real de la comunidad**, que corre en OTRA máquina (`192.168.2.251:28960`, subred `192.168.2.x` — este PC está en `192.168.3.x`), hay dos opciones:

**(a) Compartir por SMB la carpeta de logs de esa máquina** y leerla por UNC desde aquí:

1. En `192.168.2.251`: comparte la carpeta de logs (ej. `D:\Call of Duty 6\userraw\logs`) como `iw4x-logs` con permiso de **LECTURA** para este PC. El server de esa máquina necesita `logfile 2` en su `server.cfg` (sin eso no hay games_mp.log que parsear).
2. En este PC, `apps/api/.env`:

```ini
GAME_LOG_PATH='\\192.168.2.251\iw4x-logs\games_mp.log'
GAME_SERVER_ADDRESS=192.168.2.251:28960
```

> ⚠️ En `.env`, para rutas UNC usa **comillas simples** (dotenv no toca los backslashes) y verifica que la ruta no contenga secuencias `\n` si usas comillas dobles. Usa SIEMPRE la misma escritura de la ruta (el offset del cursor se guarda por ruta exacta).

**(b) Correr la API directamente en esa máquina** (clonar el repo ahí, `npm install`, `db:push`, y configurar `GAME_LOG_PATH` con la ruta local del log). Recomendado si la red entre subredes (`192.168.2.x` ↔ `192.168.3.x`) bloquea SMB o da latencia.

## 4E. Server dedicado en otra PC (192.168.2.251)

Si quisieras montar en esa máquina un server **puro** (sin cliente de juego):

1. Copia la instalación del juego a `192.168.2.251` y recórtala con [shrink-iw4x](https://github.com/mxve/shrink-iw4x) (elimina assets que el server dedicado no necesita → ~7GB).
2. Instala las configs oficiales igual que en [4B](#4b-servidor-dedicado-local-de-pruebas-configs-oficiales-alterware) y **asegura `logfile 2`** + `g_log` en su `server.cfg` (sin log no hay ingesta).
3. Comparte la carpeta de logs por SMB y apunta la API de este PC por UNC ([4D](#4d-modo-log-remoto-server-192168225128960)), o corre la API en esa máquina.

## 4F. Conectar un IW4MAdmin real (alternativa)

El reader de IW4MAdmin sigue disponible y es **combinable** con el log ([4C](#4c-ingesta-por-log-del-server-dedicado)). Si solo usas IW4MAdmin:

1. Localiza la base: `<carpeta de IW4MAdmin>/Database/Database.sqlite`.
2. En `apps/api/.env`: `IW4MADMIN_DB_PATH=C:/IW4MAdmin/Database/Database.sqlite`
3. Corre `npm run sync` (o `POST /api/sync` autenticado) y revisa el campo `warnings` del resultado.

**Seguridad del sync (reader IW4MAdmin):**

- La fuente se abre con better-sqlite3 en modo `readonly: true` + `fileMustExist: true` → **la API nunca escribe en la DB de IW4MAdmin**.
- Antes de consultar, lee el esquema real con `PRAGMA table_info` de `EFClient`, `EFClientKill` y `EFServer`; solo usa columnas presentes (`CurrentName ?? Name`, `IsKill`, `Damage`, `Weapon`, `ServerId`, … opcionales).
- Cada tabla corre en try/catch: si falta algo esencial se registra en `warnings` y el sync continúa con datos parciales (nunca rompe).
- Formatos tolerados en fechas: TEXT ISO-8601 (`2024-05-01T12:00:00Z`, con espacio, sin zona) y epoch numérico (segundos o ms).
- `NetworkId` se lee con `safeIntegers: true` (BigInt) y se almacena como string decimal — soporta GUIDs de 64 bits sin pérdida.
- Agregaciones (kills/deaths/K/D/tiempo/conexiones/skill) se recalculan completas en cada sync con `GROUP BY`; los kill events individuales se importan **incrementalmente** (`Time > último epoch sincronizado`), por lo que re-sincronizar es barato.
- Si ambas fuentes están activas a la vez: IW4MAdmin recalcula agregados completos (su fuente es autoritativa) y el log añade sus eventos/delta incrementalmente encima.

## 4G. IW4MAdmin (moderación)

Instalado como **suite de moderación** (bans / penalidades / reportes / comandos in-game / webfront) — **NO como fuente de stats**. Ver sección 4C para la fuente del ranking.

> ⚠️ **DEPRECATED para la moderación del panel**: desde la migración a **moderación nativa por RCON** (ver [docs/API.md §Moderación](API.md#moderación-nativa-rcon-iw4x--apiadminiam--admin)), el panel admin del ranking ya NO depende de IW4MAdmin ni de su webfront/SQLite: habla directo con el server por RCON (`RCON_PASSWORD` en `apps/api/.env`). IW4MAdmin puede seguir corriendo como herramienta paralela (webfront/comandos in-game) o apagarse sin afectar al panel. La env `IW4MADMIN_DB_PATH` sigue siendo SOLO una fuente alternativa de stats (ver nota al final de la sección).

- **Versión**: IW4MAdmin 2025.12.16.1 (último estable del [repo oficial](https://github.com/RaidMax/IW4M-Admin))
- **Ubicación**: `D:\IW4MAdmin` (fuera del repo y de la carpeta del juego)
- **Requisito**: .NET 10.x ASP.NET Core (runtime 10.0.14 instalado vía `winget install Microsoft.DotNet.AspNetCore.10 --source winget --silent`)
- **Config**: `D:\IW4MAdmin\Configuration\IW4MAdminSettings.json` (pre-escrita, sin first-run interactivo):
  - Server: `127.0.0.1:28961`, RCon parser `Call of Duty`, `ManualLogPath` = `D:\Call of Duty 6\userraw\logs\games_mp.log`, `Password` = el `rcon_password` de `userraw\server.cfg` (sincronizar a mano si cambias la cfg)
  - Webfront: `http://0.0.0.0:1624` → entra por <http://127.0.0.1:1624>
  - DB propia (SQLite, solo para IW4MAdmin): `D:\IW4MAdmin\Database\Database.db` — NO es la del ranking
- **Logs**: `D:\IW4MAdmin\Log\` y consola redirigida a `D:\IW4MAdmin\console.stdout.log` / `console.stderr.log`

### Arrancar / parar

```powershell
# Arrancar (con UI de ventana):
D:\IW4MAdmin\StartIW4MAdmin.cmd
# Arrancar headless (recomendado si el server ya corre):
Start-Process -FilePath 'C:\Program Files\dotnet\dotnet.exe' -ArgumentList 'Lib\IW4MAdmin.dll','--no-confirm' -WorkingDirectory 'D:\IW4MAdmin' -WindowStyle Hidden

# Parar (kill del proceso dotnet de IW4MAdmin):
Get-CimInstance Win32_Process -Filter "Name='dotnet.exe'" |
  Where-Object { $_.CommandLine -like '*Lib\IW4MAdmin.dll*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

IW4MAdmin solo necesita que el server dedicado esté corriendo: se conecta por RCon a 28961 (hace polling cada `RConPollRate` ms = 5s) y lee el `games_mp.log` en modo lectura (sin conflicto con la ingesta del ranking por log).

### Reclamar ownership

1. En el chat del juego, escribiendo `!owner` — el primer humano conectado que lo escribó se convierte en owner de esa instancia (verificado: el comando existe mientras no haya owner en la DB).
2. In-game: `!rt` (register) genera las credenciales de tu cuenta para login en el webfront (`http://127.0.0.1:1624` → Login). Con el webfront logeado podés administrar bans/mutear/reportes desde la web.
3. Comandos moderación desde webfront o chat: `!ban`, `!warn`, `!mute`, `!kick` (ver `!help`).

> ℹ️ El log de IW4MAdmin marca `[GameInterface] gsc integration is disabled` — la integración GSC es opcional (habilita funciones avanzadas). Si algún comando in-game no llegara a funcionar, copia `D:\IW4MAdmin\GameFiles\_integration_iw4x.gsc` a la carpeta de scripts del server (`userraw\iw4x\scripts`) y reinicia el server.

> 🚨 **NOTA IMPORTANTE — fuentes de datos**: el ranking **NO ingiere la DB de IW4MAdmin por defecto** (fuente = `games_mp.log`, ver [4C](#4c-ingesta-por-log-del-server-dedicado)). Para cambiar de fuente: config `IW4MADMIN_DB_PATH` y comenta `GAME_LOG_PATH` — **nunca dejes las dos activas contra el MISMO server** (doble conteo de kills). Ver [4F](#4f-conectar-un-iw4madmin-real-alternativa). `IW4MADMIN_DB_PATH` queda **comentado/desactivado a propósito** en `apps/api/.env`; NO tocar mientras el ranking use el log.

## 5. Ejecutar

```powershell
npm run dev:api        # desarrollo con watch (tsx) → http://localhost:3000
npm run build          # compila apps/api → apps/api/dist (prisma generate + tsc)
npm run start:api      # ejecuta el build compilado (node dist/index.js)
npm run sync           # sync manual por CLI (sin servidor)
```

Sync automático: setea `SYNC_INTERVAL_MINUTES=30` (ej.) en `apps/api/.env`; al arrancar, la API loguea `[sync] sincronización automática activa cada 30 minuto(s)`. No se solapan corridas.

## 6. Tests

```powershell
npm test
```

Vitest (64 tests): auth (registro/login/me/validaciones), sync defensivo con DB mock determinista (agregaciones, incrementalidad), ingesta por games_mp.log con logs sintéticos (J/K/D/Q, InitGame con estado, world/suicidio/teamkill/headshot, sesiones, offsets en bytes, truncados), armas/mapas (ranking global, desglose por jugador, favoritos) y flujo completo de vinculación GUID. Los tests usan su propia SQLite (`apps/api/prisma/test.db`) y sus propios fixtures (`apps/api/tests/data/`), nunca tu `dev.db`.

## 7. Frontend

`apps/web` está reservado (placeholder). El contrato exacto de endpoints está en [`docs/API.md`](API.md). La API ya tiene CORS habilitado para `http://localhost:5173`.

## Problemas comunes

| Síntoma | Causa / solución |
| ------- | ---------------- |
| `503 SYNC_NOT_CONFIGURED` | No hay fuente: configura `IW4MADMIN_DB_PATH` **o** `GAME_LOG_PATH` en `apps/api/.env` |
| `503 SYNC_SOURCE_UNAVAILABLE` | Ruta incorrecta o archivo bloqueado; usa barras normales en el path |
| `[GameLog] el archivo no existe` | `GAME_LOG_PATH` mal escrito o el server no ha corrido nunca con `logfile 2` |
| `[GameLog] 12 líneas no reconocidas` | Normal: separadores `----`, `ExitLevel` y `ShutdownGame` se ignoran a propósito (se reflejan en el contador, no son error) |
| `sync` con `warnings` de columnas | Versión de IW4MAdmin con esquema distinto: es comportamiento defensivo; revisa qué columnas lista el warning |
| Leaderboard vacío | Sin jugadores: con fuente log, el leaderboard se llena cuando **jugadores reales** se conecten y maten (los bots de `scr_testclients` no llegaron a aparecer en la build r5318) |
| El log no aparece en `userraw\logs\` | El `g_log` de la cfg oficial escribe `logs/games_mp.log`; si tu cfg dice `games_mp.log` a secas, cae en `userraw\` raíz. Usa SIEMPRE la ruta real en `GAME_LOG_PATH` |
| `link/complete` devuelve 0 candidatos | El jugador no se conectó en los últimos `LINK_WINDOW_MINUTES` minutos, o no hubo sync desde entonces → con SYNC_INTERVAL_SECONDS=30 el ingest es casi en vivo; con el mock: `npm run mock:refresh-connections` + `npm run sync` |
| Tokens se invalidan al reiniciar | `JWT_SECRET` no configurado en dev (se genera efímero); configúralo |

## CI

El workflow [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) corre en cada push a `main` y en cada pull request (runner `ubuntu-latest`, Node 20 con cache de npm). Valida:

1. **Instalación limpia**: `npm ci` en la raíz (instala los workspaces y genera el cliente de Prisma).
2. **API**: `npm run build -w apps/api` (`prisma generate` + `tsc`) y `npm test -w apps/api` (los 64 tests de vitest). No necesita pasos previos: el global setup de vitest crea su propia `test.db` y sus fixtures (DB mock de IW4MAdmin y logs sintéticos), sin tocar `dev.db` ni bases reales.
3. **Web**: el paso de build del frontend está comentado con un TODO hasta que exista `apps/web/package.json` (hoy `apps/web` es un placeholder).
4. **Smoke**: paso final que confirma que el pipeline completo terminó OK.

No usa secrets ni servicios externos (sin Postgres): todo funciona con SQLite efímera generada en el propio runner.
