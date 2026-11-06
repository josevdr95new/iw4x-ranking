# API — IW4x Ranking (contrato para el frontend)

- **Base URL**: `http://localhost:3000`
- Todas las rutas viven bajo el prefijo **`/api`**.
- Formato: JSON en request y response.
- Fechas: ISO-8601 UTC (`2026-11-05T22:03:18.518Z`).
- **Autenticación**: `Authorization: Bearer <JWT>` (vía `POST /api/auth/register` o `/login`). Expiración por defecto: 7 días (`JWT_EXPIRES_IN`).
- **GUID**: el `NetworkId` de IW4MAdmin, como **string numérica** (puede superar 2^53; no lo conviertas a número en JS).
- CORS habilitado para `http://localhost:5173` (configurable con `CORS_ORIGIN`, admite lista separada por comas).

## Envelope de error

Todo error (4xx/5xx) responde:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Datos de entrada inválidos.",
    "details": { "issues": [{ "path": "password", "message": "La contraseña debe tener al menos 8 caracteres" }] }
  }
}
```

| `code`                   | HTTP | Cuándo ocurre |
| ------------------------ | ---- | ------------- |
| `VALIDATION_ERROR`       | 400  | Body/query/params inválidos (`details.issues` describe cada campo) |
| `INVALID_JSON`           | 400  | El cuerpo no es JSON parseable |
| `UNAUTHORIZED`           | 401  | Falta token, token inválido/expirado o cuenta eliminada |
| `INVALID_CREDENTIALS`    | 401  | Login con email o password incorrectos |
| `EMAIL_TAKEN`            | 409  | Registro con email ya existente |
| `USER_ALREADY_LINKED`    | 409  | El usuario ya tiene un GUID vinculado |
| `GUID_ALREADY_LINKED`    | 409  | El GUID ya pertenece a otra cuenta |
| `NOT_FOUND`              | 404  | Ruta inexistente |
| `PLAYER_NOT_FOUND`       | 404  | GUID desconocido (¿corriste sync?) |
| `SYNC_NOT_CONFIGURED`    | 503  | `IW4MADMIN_DB_PATH` no configurada |
| `SYNC_SOURCE_UNAVAILABLE`| 503  | La DB de IW4MAdmin no existe o no se pudo abrir |
| `INTERNAL`               | 500  | Error no controlado |

---

## Health

### `GET /api/health`

```json
{ "status": "ok", "uptime": 123.45, "now": "2026-11-05T22:00:00.000Z" }
```

---

## Auth

> **Roles**: todo `user` ahora incluye `role: "USER" | "ADMIN"`. Los emails en `ADMIN_EMAILS` (env, separados por coma) reciben ADMIN automáticamente al **registrarse o loguear**; también existe `npm run promote:admin -- <email>` (`--demote` para revertir). Los endpoints `/api/admin/*` exigen `role=ADMIN` (403 `FORBIDDEN` en caso contrario; el rol se lee fresco de la DB en cada request).

### `POST /api/auth/register`

Request:

```json
{ "email": "player@example.com", "password": "minimo8chars", "displayName": "MiTag" }
```

Validación: `email` válido (se normaliza a minúsculas), `password` 8–72, `displayName` 3–32.

Response **201**:

```json
{
  "user": {
    "id": 2,
    "email": "docs-capture@test.local",
    "displayName": "Docs Capture",
    "createdAt": "2026-11-05T22:03:18.518Z",
    "linkedGuid": null
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOjIsImlhdCI6..."
}
```

Errores: `400 VALIDATION_ERROR`, `409 EMAIL_TAKEN`.

### `POST /api/auth/login`

Request: `{ "email": "player@example.com", "password": "..." }`
Response **200**: igual que register (`{ user, token }`).
Errores: `400 VALIDATION_ERROR`, `401 INVALID_CREDENTIALS` (mismo código para email inexistente o password incorrecta).

### `GET /api/auth/me` 🔒

Header: `Authorization: Bearer <token>`

Response **200**:

```json
{
  "user": {
    "id": 2,
    "email": "docs-capture@test.local",
    "displayName": "Docs Capture",
    "role": "USER",
    "createdAt": "2026-11-05T22:03:18.518Z",
    "linkedGuid": "263534314041025950",
    "linkedGuids": [
      {
        "guid": "263534314041025950",
        "lastConnection": "2026-11-05T22:05:41.102Z",
        "lastServer": "192.168.3.99:28961"
      }
    ]
  }
}
```

`linkedGuid` es `null` hasta completar la vinculación (ver abajo). `role` es `USER` o `ADMIN`. `linkedGuids` incluye todos los GUIDs vinculados con los metadatos de su Player (`lastConnection`/`lastServer` en `null` si aún no jugó). Errores: `401 UNAUTHORIZED`.

---

### `PATCH /api/auth/me` ✅ (perfil de usuario)

Cambia `displayName` y/o `password` (al cambiar password hay que validar la actual).

Request (uno o ambos campos):

```json
{ "displayName": "Nuevo Nombre", "currentPassword": "actual1234", "password": "nuevapassword1" }
```

Response **200**: `{ "user": { ...PublicUser } }` (misma forma que GET /me).

Errores: `400 VALIDATION_ERROR` (displayName <3 chars, password <8, password sin `currentPassword`, body vacío), `401 INVALID_CREDENTIALS` si `currentPassword` no coincide.
## Vinculación cuenta ↔ GUID (login juego→web)

Flujo sin plugins: el usuario debe **jugar unos minutos** y luego, desde la web, buscar candidatos y confirmar cuál es su GUID.

1. 🔒 `POST /api/link/start` — registra el intento (timestamp) para el usuario.
2. 🔒 `POST /api/link/complete` **sin body** (o `{}`) — devuelve GUIDs **sin cuenta vinculada** cuya última conexión al juego es reciente (ventana `LINK_WINDOW_MINUTES`, default 10 minutos).
3. El usuario confirma el suyo → 🔒 `POST /api/link/complete` con `{ "guid": "..." }` — vincula (1 a 1).

### `POST /api/link/start` 🔒

Response **200**:

```json
{
  "attemptId": 1,
  "status": "pending",
  "windowMinutes": 10,
  "createdAt": "2026-11-05T22:05:00.000Z"
}
```

### `POST /api/link/complete` 🔒 — sin `guid` (candidatos)

Request: body vacío o `{}`.

Response **200**:

```json
{
  "status": "candidates",
  "windowMinutes": 10,
  "candidates": [
    { "guid": "263534314041025950", "name": "ZombieSlayer69", "lastConnection": "2026-11-05T21:59:06.318Z" },
    { "guid": "373050346043892200", "name": "Thermal_Predator", "lastConnection": "2026-11-05T21:57:55.318Z" }
  ]
}
```

Ordenado por conexión más reciente primero. Si la lista viene vacía: el jugador debe conectarse al servidor y esperar el siguiente sync (o `POST /api/sync`).

### `POST /api/link/complete` 🔒 — con `guid` (confirmar)

Request: `{ "guid": "263534314041025950" }`

Response **200**:

```json
{
  "status": "linked",
  "guid": "263534314041025950",
  "name": "ZombieSlayer69",
  "server": "192.0.2.5",
  "linkedAt": "2026-11-05T22:06:10.000Z"
}
```

`server` es el último servidor conocido del jugador (misma resolución que en los candidatos: conexión si la fuente la expone, si no último evento registrado; `null` si no hay dato).

Errores: `400 VALIDATION_ERROR` (formato no numérico), `404 PLAYER_NOT_FOUND`, `409 GUID_ALREADY_LINKED`.

> **MULTI-GUID (PCs compartidas)**: una cuenta puede tener **N GUIDs** vinculados. El `409 USER_ALREADY_LINKED` **ya no existe** para GUIDs nuevos (se vinculan sin error). Se mantiene `409 GUID_ALREADY_LINKED` si el GUID pertenece a **otra** cuenta. Re-vincular un GUID propio → **200 idempotente**. Respuesta idéntica a la que ya consume el launcher.

### `DELETE /api/link/:guid` 🔒 (desvincular GUID propio)

Libera un GUID de la cuenta autenticada (para cambiar de cuenta en PCs compartidas). Solo actúa sobre vínculos PROPIOS.

Response **200**:

```json
{ "status": "unlinked", "guid": "263534314041025950", "linkedGuids": ["263534314041025951"] }
```

Errores: `400 VALIDATION_ERROR` (GUID no numérico), `404 NOT_FOUND` si la cuenta no tiene ese GUID (también si pertenece a otro usuario — no revela existencia).

### `GET /api/servers` (público)

Lista de servers conocidos para launcher/web sin hardcodear. Fuente: env `SERVERS` (JSON array `[{name, address, isDefault?}]`); si falta, se deriva de `GAME_SERVER_ADDRESS`; sin ninguna fuente, lista vacía.

Response **200**:

```json
{
  "source": "env",
  "servers": [
    { "name": "LAN Server", "address": "192.168.2.251:28960", "isDefault": false },
    { "name": "Test Local", "address": "192.168.3.99:28961", "isDefault": true }
  ]
}
```

Si ninguna entrada marca `isDefault`, la primera lo recibe. `source` ∈ `env | derived | none` (informativo).

---

## Admin (requiere rol ADMIN)

> Todas las rutas bajo `/api/admin/*` exigen JWT + `role=ADMIN` (`401` sin token, `403 FORBIDDEN` con USER). El rol se lee fresco de la DB en cada request.

### `GET /api/admin/server-config` 🔒

Parsea el `server.cfg` REAL (`SERVER_CFG_PATH`) del server dedicado y lo devuelve como estructura tipada. Las líneas que el panel no gestiona se devuelven **intactas** en `unknownLines` (incluyen dvars no editables y `map_rotate`).

Response **200** (ejemplo con el cfg oficial AlterWare):

```json
{
  "config": {
    "hostname": "^7[^1RANKING^7] ^7Local Test Server",
    "motd": "Bienvenidos al ranking",
    "gametype": "war",
    "maxclients": 12,
    "logfile": 2,
    "g_log": "logs/games_mp.log",
    "rcon": "09••••14",
    "rconSet": true,
    "bots": 4,
    "password": null,
    "passwordSet": false,
    "rotation": [
      { "map": "mp_rust", "gametype": "war" },
      { "map": "mp_terminal", "gametype": "war" },
      { "map": "mp_highrise", "gametype": "war" },
      { "map": "mp_cross_fire", "gametype": "war" },
      { "map": "mp_strike", "gametype": "war" }
    ],
    "unknownLines": [
      "set sv_securityLevel \"23\"",
      "set g_inactivity \"300\"",
      "map_rotate"
    ],
    "metadata": { "path": "D:\\Call of Duty 6\\userraw\\server.cfg", "lastModified": "2026-11-06T20:30:00.000Z", "sizeBytes": 9831 }
  }
}
```

- `rcon`/`password` salen **ENMASCARADOS** (`ab••••yz`); `rconSet`/`passwordSet` indican si tienen valor real.
- Errores: `503 SERVER_CFG_NOT_CONFIGURED` (env sin setear), `503 SERVER_CFG_NOT_FOUND` (archivo inexistente).

### `PUT /api/admin/server-config` 🔒

Actualiza SOLO los campos que llegan (parcial) y **regenera** el cfg preservando `set/seta`, comentarios trailing y las `unknownLines` tomadas del DISCO (el cliente no puede inyectar líneas crudas — el schema rechaza claves desconocidas). Backup automático `server.cfg.bak-<timestamp>` + escritura **atómica** (tmp + rename). Con `ALLOW_SERVER_CONTROL=1` además reinicia el server tras guardar (necesita `SERVER_RESTART_COMMAND`; si falta, guarda igual y añade `warnings`).

Request (todos los campos opcionales; `null` en rcon/password = vaciar):

```json
{
  "hostname": "^7[^1RANKING^7] ^7Servidor de la Comunidad",
  "motd": "Ranking activo: juega y sube",
  "gametype": "war",
  "maxclients": 24,
  "logfile": 2,
  "g_log": "logs/games_mp.log",
  "rcon": "nuevo-rcon-seguro-1",
  "bots": 4,
  "password": null,
  "rotation": [
    { "map": "mp_rust", "gametype": "war" },
    { "map": "mp_terminal", "gametype": "war" },
    { "map": "mp_shipment", "gametype": "dm" }
  ]
}
```

- El **eco enmascarado** de `rcon`/`password` (contiene `•`) se interpreta como "sin cambio".
- Validaciones: `maxclients` 1–64, `logfile` 0–2, `bots` 0–24 y **≤ maxclients**, `hostname` ≤64 sin comillas/saltos, `gametype` ∈ war|dm|dom|koth|sab|sd|ctf|oneflag|gtnw|arena|dd|vip, `rotation` 1–32 mapas `^[a-z0-9_]{2,32}$`.

Response **200**:

```json
{ "saved": true, "restarted": false, "backupPath": "D:/Call of Duty 6/userraw/server.cfg.bak-2026-11-06T20-40-00-000Z", "warnings": [] }
```

Errores: `400 VALIDATION_ERROR` (con detalles por campo; el cfg NO se toca), `503 SERVER_CFG_*`, `500 SERVER_CFG_WRITE_FAILED` (con rollback al contenido previo).

### `POST /api/admin/server/restart` 🔒

Reinicia el proceso del server dedicado ejecutando `SERVER_RESTART_COMMAND` (child_process, timeout 20s). **Triple guard**: rol ADMIN **+** `ALLOW_SERVER_CONTROL=1` **+** `SERVER_RESTART_COMMAND` configurado — sin nada de eso responde **403 FORBIDDEN** y NO ejecuta nada.

Response **200**: `{ "restarted": true, "command": "taskkill /F /IM iw4x.exe & ..." }`

---

## Leaderboard (público)

### `GET /api/leaderboard`

Query params (todos opcionales):

| Param       | Valores / default                          |
| ----------- | ------------------------------------------ |
| `sort`      | `kills` (default) \| `deaths` \| `kd` \| `timePlayed` \| `skill` |
| `order`     | `desc` (default) \| `asc`                  |
| `search`    | substring del nombre (case-insensitive, ASCII) |
| `page`      | ≥ 1 (default 1)                            |
| `pageSize`  | 1–100 (default 20)                         |
| `minMatches`| filtra `connections >= N` (default 0 = sin filtro) |

Ejemplo: `GET /api/leaderboard?sort=kills&order=desc&page=1&pageSize=2`

Response **200** (ejemplo real):

```json
{
  "page": 1,
  "pageSize": 2,
  "total": 50,
  "totalPages": 25,
  "sort": "kills",
  "order": "desc",
  "players": [
    {
      "rank": 1,
      "guid": "341831007923465200",
      "name": "CarePackage_Sniper",
      "kills": 289,
      "deaths": 182,
      "kd": 1.59,
      "timePlayed": 593392,
      "connections": 29,
      "skill": 17.63,
      "lastConnection": "2026-11-02T21:59:06.318Z",
      "linked": false
    },
    {
      "rank": 2,
      "guid": "977082674952689500",
      "name": "Chopper_Gunner",
      "kills": 280,
      "deaths": 153,
      "kd": 1.83,
      "timePlayed": 521415,
      "connections": 424,
      "skill": 20.23,
      "lastConnection": "2026-10-04T21:59:06.318Z",
      "linked": true
    }
  ]
}
```

Unidades: `timePlayed` en **segundos**; `linked` es `true` si ese GUID tiene una cuenta web vinculada (ver sección Vinculación).

> **`rank` es SIEMPRE la posición GLOBAL** del jugador en el ranking por defecto (`kills` desc, empate por `name` asc), **independientemente de la búsqueda, los filtros y la paginación**. Con una búsqueda activa, el único match de un jugador que es #39 global se muestra con `rank: 39` (no `#1`). En paginación, la página 2 muestra ranks globales continuos (`6, 7, 8…`), no `1, 2, 3`.

Errores: `400 VALIDATION_ERROR` (p. ej. `sort=hacks`).

---

## Perfil de jugador (público)

### `GET /api/players/:guid`

Response **200** (ejemplo real, truncado):

```json
{
  "player": {
    "guid": "341831007923465200",
    "name": "CarePackage_Sniper",
    "kills": 289,
    "deaths": 182,
    "kd": 1.59,
    "timePlayed": 593392,
    "connections": 29,
    "skill": 17.63,
    "headshots": 61,
    "headshotPct": 21.11,
    "damageDealt": 25870,
    "damageTaken": 18322,
    "bestStreak": 9,
    "teamkills": 2,
    "matchesPlayed": 14,
    "favoriteWeapon": "ak47",
    "favoriteMap": "mp_rust",
    "firstConnection": "2026-02-27T21:59:06.318Z",
    "lastConnection": "2026-11-02T21:59:06.318Z",
    "linked": false
  },
  "rank": 1,
  "recentEvents": [
    {
      "id": 8925,
      "time": "2026-11-02T06:03:37.000Z",
      "epoch": 1793599417,
      "direction": "kill",
      "isKill": true,
      "damage": 248,
      "weapon": "ak47",
      "server": "192.168.3.99:28961",
      "opponentGuid": "977082674952689500",
      "opponentName": "Chopper_Gunner"
    }
  ],
  "byServer": [
    { "server": "192.168.3.99:28961", "kills": 20, "deaths": 10 }
  ]
}
```

Notas para el frontend:

- `rank`: posición global del jugador con el **mismo criterio por defecto del leaderboard** (`sort=kills&order=desc`, empate por `name` asc). Es `null` solo si el jugador no clasifica en ese ranking (con los criterios actuales, todo jugador sincronizado tiene rank). Evita hacer lookup al top-N para calcular la posición.
- `recentEvents`: últimos 20 eventos del jugador, más reciente primero. `direction` es `kill` (el jugador fue el origen) o `death` (fue el objetivo). `isKill: false` = evento no letal registrado por IW4MAdmin.
- `weapon`: con fuente IW4MAdmin es el **id crudo** (número como string); con fuente log (games_mp.log) es el **nombre base del arma** (`ak47`, `m1014`, ...). El mapping a nombre legible no está implementado aún.
- `server` puede ser `null` si la fuente no expone servidor. Con fuente log es el valor de `GAME_SERVER_ADDRESS`.
- Campos nuevos (fuente log): `headshots`/`headshotPct` (hitloc `head`/`helmet` sobre kills), `damageDealt`/`damageTaken` (suma de daño de líneas K + D), `bestStreak` (mejor racha de kills sin muerte intercalada; aprox: solo eventos K almacenados), `teamkills` (ateam == vteam), `matchesPlayed` (mapas distintos con actividad), `favoriteWeapon`/`favoriteMap` (arma/mapa con más kills; `null` sin actividad).
- `timePlayed` (fuente log) = suma de sesiones reales J→Q (las abiertas cuentan como en curso, cap 4h).
- `linked`: si el GUID tiene cuenta web vinculada.

Errores: `400 VALIDATION_ERROR` (GUID no numérico), `404 PLAYER_NOT_FOUND`.

### `GET /api/players/:guid/history?days=30`

Series temporales simples por día UTC, con zero-fill (siempre devuelve `days` puntos). `days` ∈ 1–90, default 30.

Response **200** (ejemplo con `days=3`):

```json
{
  "guid": "341831007923465200",
  "name": "CarePackage_Sniper",
  "days": 3,
  "series": [
    { "date": "2026-11-03", "kills": 0, "deaths": 0 },
    { "date": "2026-11-04", "kills": 2, "deaths": 1 },
    { "date": "2026-11-05", "kills": 5, "deaths": 3 }
  ]
}
```

Errores: `400 VALIDATION_ERROR` (`days` fuera de 1–90), `404 PLAYER_NOT_FOUND`.

### `GET /api/players/:guid/weapons`

Desglose por arma del jugador: kills, daño, headshots y muertes por arma (incluye armas con las que solo recibió muertes). `favoriteWeapon` = arma con más kills (empate: más daño, luego nombre).

Response **200**:

```json
{
  "guid": "341831007923465200",
  "name": "CarePackage_Sniper",
  "favoriteWeapon": "ak47",
  "totalKills": 289,
  "weapons": [
    { "weapon": "ak47", "kills": 210, "damage": 18350, "headshots": 52, "headshotPct": 24.76, "deaths": 31 },
    { "weapon": "m1014", "kills": 44, "damage": 3960, "headshots": 0, "headshotPct": 0, "deaths": 12 },
    { "weapon": "ak74u", "kills": 0, "damage": 0, "headshots": 0, "headshotPct": 0, "deaths": 18 }
  ]
}
```

Errores: `400 VALIDATION_ERROR`, `404 PLAYER_NOT_FOUND`.

### `GET /api/players/:guid/maps`

Desglose kills/deaths/headshots/daño por mapa (con los gametypes registrados vía `InitGame`). `favoriteMap` = mapa con más kills (empate: más daño).

Response **200**:

```json
{
  "guid": "341831007923465200",
  "name": "CarePackage_Sniper",
  "favoriteMap": "mp_rust",
  "maps": [
    { "map": "mp_rust", "kills": 120, "deaths": 45, "headshots": 30, "damageDealt": 9800, "gametypes": ["war"] },
    { "map": "mp_terminal", "kills": 85, "deaths": 51, "headshots": 12, "damageDealt": 6210, "gametypes": ["war"] }
  ]
}
```

> ⚠️ Con la build actual del server local, las líneas `InitGame` del log van **sin infostring**: `map`/`gametype` quedan `null` en los eventos y el desglose por mapa aparece como `"map": "unknown"` hasta que la build escriba el infostring (el parser soporta ambos formatos).

Errores: `400 VALIDATION_ERROR`, `404 PLAYER_NOT_FOUND`.

### `GET /api/weapons`

Ranking global de armas sobre los kill events (`isKill=true` con arma conocida). Mismo estilo de respuesta que el leaderboard: `rank` es SIEMPRE la posición global por `kills` desc (arma asc), independiente del `sort` pedido.

Query params: `sort=kills|damage|victims|headshots` (default `kills`), `order=asc|desc` (default `desc`), `page` (default 1), `pageSize` (default 20, máx 100).

Response **200**:

```json
{
  "page": 1,
  "pageSize": 20,
  "total": 2,
  "totalPages": 1,
  "sort": "kills",
  "order": "desc",
  "totalKills": 5,
  "weapons": [
    { "rank": 1, "weapon": "ak47", "kills": 3, "damage": 350, "victims": 2, "killShare": 60, "headshots": 1, "headshotPct": 33.33 },
    { "rank": 2, "weapon": "m1014", "kills": 2, "damage": 185, "victims": 2, "killShare": 40, "headshots": 1, "headshotPct": 50 }
  ]
}
```

- `killShare`: % de esta arma sobre `totalKills` (kills con arma conocida).
- `victims`: víctimas distintas que ha tenido el arma.

Errores: `400 VALIDATION_ERROR` (sort inválido, page/pageSize fuera de rango).

### Datos disponibles desde el log (y qué NO está disponible)

| Disponible (fuente games_mp.log) | No disponible desde el log |
| -------------------------------- | -------------------------- |
| kills, muertes, daño (K y D) | **accuracy/disparos** (el log no registra disparos, solo impactos) |
| arma base (`ak47`, `m1014`, ...) | attachments (ACOG, silenciador... el log reporta el arma base) |
| hitloc/headshot (head, helmet, chest...) | racha "oficial" del juego (la nuestra es una aproximación por eventos K) |
| teamkill (team atacante == víctima) | XP/score de la partida |
| mapa/modo (si `InitGame` trae infostring) | tiempo de juego exacto por partida (aproximado con J→Q) |
| sesiones J→Q (conexión/desconexión) | ping, IP, SteamID de los jugadores |

---

## Sync desde IW4MAdmin

### `POST /api/sync` 🔒

Dispara una sincronización manual (agregaciones completas + kill events incrementales). Puede tardar en DBs grandes.

Response **200** (ejemplo real de primera corrida con mock):

```json
{
  "result": {
    "ok": true,
    "startedAt": "2026-11-05T21:59:14.199Z",
    "finishedAt": "2026-11-05T21:59:16.257Z",
    "durationMs": 2058,
    "playersSynced": 50,
    "killEventsSynced": 9000,
    "warnings": []
  }
}
```

`warnings` acumula problemas no fatales del esquema fuente (columnas/tablas ausentes) — el sync continúa con lo que pueda leer. Errores: `401`, `503 SYNC_NOT_CONFIGURED`, `503 SYNC_SOURCE_UNAVAILABLE`.

### `GET /api/sync/status` (público, sin auth)

> **Cambio de contrato (v0.2):** antes requería auth y devolvía el historial de corridas (`lastRun`, `runs`). Ahora es público y ligero, pensado para mostrar "último sync" sin login.

Response **200**:

```json
{
  "lastSyncAt": "2026-11-05T22:50:07.723Z",
  "configured": true,
  "intervalMinutes": 0,
  "windowMinutes": 10
}
```

- `lastSyncAt`: timestamp ISO de la última sincronización **exitosa** (`null` si nunca hubo).
- `configured`: si hay alguna fuente de stats configurada (`IW4MADMIN_DB_PATH` **o** `GAME_LOG_PATH`).
- `intervalMinutes` / `windowMinutes`: config activa (sync automático y ventana de vinculación). Si se usa `SYNC_INTERVAL_SECONDS`, `intervalMinutes` refleja el equivalente en minutos (fraccional, ej. `0.5` para 30s).

Útil para avisar al usuario "datos actualizados hace X minutos" o "sin datos aún — corre el sync". Este endpoint NO dispara sincronizaciones (para eso, `POST /api/sync`).

---

## Resumen rápido de rutas

| Método | Ruta                      | Auth | Descripción |
| ------ | ------------------------- | ---- | ----------- |
| GET    | `/api/health`             | —    | Estado del servicio |
| POST   | `/api/auth/register`      | —    | Registro (devuelve JWT; role USER/ADMIN según ADMIN_EMAILS) |
| POST   | `/api/auth/login`         | —    | Login (devuelve JWT; auto-grant ADMIN si email ∈ ADMIN_EMAILS) |
| GET    | `/api/auth/me`            | ✅   | Usuario + `role` + `linkedGuid` (legacy) + `linkedGuids[]` con metadatos |
| PATCH  | `/api/auth/me`            | ✅   | Cambiar `displayName` y/o `password` (valida la actual) |
| POST   | `/api/link/start`         | ✅   | Registra intento de vinculación |
| POST   | `/api/link/complete`      | ✅   | Sin `guid` → candidatos; con `guid` → vincula (MULTI-GUID) |
| DELETE | `/api/link/:guid`         | ✅   | Desvincular un GUID propio |
| GET    | `/api/leaderboard`        | —    | Ranking paginado/filtrable |
| GET    | `/api/players/:guid`      | —    | Perfil ampliado + `rank` global + eventos recientes + por servidor |
| GET    | `/api/players/:guid/history` | — | Serie temporal por día |
| GET    | `/api/players/:guid/weapons` | — | Desglose por arma del jugador + favorita |
| GET    | `/api/players/:guid/maps`    | — | Desglose por mapa del jugador + favorito |
| GET    | `/api/weapons`            | —    | Ranking global de armas (kills/damage/victims/headshots) |
| GET    | `/api/servers`            | —    | Lista de servers conocidos (env `SERVERS` o derivada) |
| POST   | `/api/sync`               | ✅   | Dispara sincronización (combina IW4MAdmin y/o games_mp.log) |
| GET    | `/api/sync/status`        | —    | `{lastSyncAt, configured, intervalMinutes, windowMinutes}` (público) |
| GET    | `/api/admin/server-config` | ADMIN | Parsea el server.cfg real a estructura JSON |
| PUT    | `/api/admin/server-config` | ADMIN | Regenera el cfg (backup + escritura atómica; restart opcional) |
| POST   | `/api/admin/server/restart` | ADMIN | Reinicia el server (requiere ALLOW_SERVER_CONTROL=1) |
