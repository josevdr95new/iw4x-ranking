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
| `SYNC_NOT_CONFIGURED`    | 503  | No hay fuente de stats (`IW4MADMIN_DB_PATH` o `GAME_LOG_PATH`) |
| `SYNC_SOURCE_UNAVAILABLE`| 503  | La DB fuente de stats no existe o no se pudo abrir |
| `MODERATION_NOT_CONFIGURED` | 503 | Moderación nativa: falta `RCON_PASSWORD` |
| `MODERATION_UNREACHABLE` | 502  | Moderación: el server IW4x no respondió por RCON (timeout tras reintentos; password/throttle/caído) |
| `MODERATION_TARGET_NOT_FOUND` | 404 | Moderación: `clientId` inexistente o nombre sin match exacto entre conectados |
| `MODERATION_INTERNAL`    | 500  | Error interno del servicio de moderación |
| `TARGET_IS_BOT`          | 403  | Moderación: warn/tempban/ban a un bot (solo kick permitido) |
| `CID_MISMATCH`           | 409  | Moderación: el slot cambió de jugador entre lectura y acción (anti-TOCTOU; nada se envió) |
| `MODERATION_BANS_FILE_CORRUPT` | 502 | Moderación: `RCON_BANS_FILE` no es JSON válido |
| `SHA_MISMATCH`           | 400  | Cloud save: el `sha256` declarado no coincide con el hash real del contenido (server recalcula) |
| `SAVE_NOT_FOUND`         | 404  | Cloud save: la cuenta nunca subió un save |
| `SAVE_VERSION_NOT_FOUND` | 404  | Cloud save: la `version` pedida no existe o fue podada (se conservan las últimas 10) |
| `SAVE_FILE_NOT_FOUND`    | 404  | Cloud save: ese `path` no está en la versión pedida |
| `INTERNAL`               | 500  | Error no controlado |

---

## Health

### `GET /api/health`

```json
{ "status": "ok", "uptime": 123.45, "now": "2026-11-05T22:00:00.000Z" }
```

---

## Auth

> **Admin por defecto (seed)**: en el primer arranque con la tabla User vacía la API auto-crea un admin (`npm run seed:admin` lo crea/promueve manualmente; envs `ADMIN_NICK`/`ADMIN_EMAIL`/`ADMIN_PASSWORD`, defaults `admin` / `admin@admin.com` / `admin123`; `SEED_DEFAULT_ADMIN=0` desactiva el auto-seed). Si el admin ya existe, el seed **nunca** resetea su contraseña, solo asegura el rol. Ver `docs/INSTALACION.md`.
>
> **El email NO es credencial**: el login (`POST /api/auth/login`) es exclusivamente por **nick** (`identifier`); enviar un email en el campo devuelve 401 genérico. El email solo sirve para gestión de la cuenta (recuperación, promoción admin).

> **Roles**: todo `user` ahora incluye `role: "USER" | "ADMIN"`. Los emails en `ADMIN_EMAILS` (env, separados por coma) reciben ADMIN automáticamente al **registrarse o loguear**; también existe `npm run promote:admin -- <email>` (`--demote` para revertir). Los endpoints `/api/admin/*` exigen `role=ADMIN` (403 `FORBIDDEN` en caso contrario; el rol se lee fresco de la DB en cada request).

### `POST /api/auth/register`

> El `email` es SOLO para gestión de la cuenta (recuperación, promoción admin). **NO es credencial de acceso**: el login es exclusivamente por nick.

Request:

```json
{ "email": "player@example.com", "password": "minimo8chars", "displayName": "MiTag" }
```

Validación: `email` válido (se normaliza a minúsculas), `password` 8–72, `displayName` 3–32.

**Nick reservado**: el `displayName` se registra como único case-insensitive (comparación sobre `cleanName` = sin códigos de color `^X`, trim, lowercase). Si OTRO usuario ya lo reservó → `409 NICK_TAKEN` ("Ese nick ya está reservado por otra cuenta"). El propio usuario puede conservar/re-reservar su mismo nick (con o sin `^X` o mayúsculas distintas) sin error. Espacios de los extremos se recortan antes de comparar.

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

Errores: `400 VALIDATION_ERROR`, `409 EMAIL_TAKEN`, `409 NICK_TAKEN` (nick reservado por OTRA cuenta).

### `POST /api/auth/login` (SOLO por nick)

**El login es exclusivamente por displayName (nick).** El email NO es credencial de acceso: solo sirve para gestión/recuperación/admin.

Request (campo nuevo `identifier`):

```json
{ "identifier": "MiTag", "password": "..." }
```

- La búsqueda es por `displayNameNormalized` EXACTO (misma normalización del nick reservado: sin `^X`, trim, lowercase → login case-insensitive y tolerante a códigos de color).
- **Compat transitoria**: el campo legacy `email` se acepta con el MISMO tratamiento — debe contener un NICK. Un email en el campo simplemente no coincide con ningún nick → `401` genérico.
- El rol sigue leyéndose fresco en login (auto-grant ADMIN para emails en `ADMIN_EMAILS`).

Response **200**: igual que register (`{ user, token }`).
Errores: `400 VALIDATION_ERROR` (sin `identifier`/`email`, o <3/>64 chars), `401 INVALID_CREDENTIALS` (mismo código genérico para nick inexistente o password incorrecta — no se revela si el nick existe).

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

El nuevo `displayName` respeta la reserva de nick: si OTRO user ya lo tiene (case-insensitive, sin `^X`) → `409 NICK_TAKEN`; conservar el propio nunca choca.

Errores: `400 VALIDATION_ERROR` (displayName <3 chars, password <8, password sin `currentPassword`, body vacío), `401 INVALID_CREDENTIALS` si `currentPassword` no coincide, `409 NICK_TAKEN`.
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

## Cloud save de progresión (`/api/profile/*`) 🔒

> Todas las rutas exigen JWT normal (`401` sin token). **Cada usuario solo accede a SU save**: el userId sale SIEMPRE del token, nunca del request. Es el mecanismo para que un jugador recupere su nivel/armas/clases en cualquier PC.

**Qué se sincroniza** (paths whitelisted, el binario es data opaca del juego — la API solo valida ruta/tamaño/hash, NUNCA el contenido interno):

| path relativo | Contenido |
| ------------- | --------- |
| `guid.dat` | ⚠️ **IDENTIDAD**: clave ECC de la que IW4x deriva el GUID (`%LOCALAPPDATA%\iw4x\guid.dat`, <4 KB) |
| `iw4x.stat` | Progresión (nivel/armas/clases, ~8.2 KB) |
| `iw4x_config.cfg` | Preferencias + name (~14 KB) |
| `mods/<mod>/iw4x.stat` | Progresión por mod (`<mod>` = `[A-Za-z0-9_-]+`) |
| `mods/<mod>/iw4x_config.cfg` | Config por-mod (nombre/clan editados con el mod activo) |

> **NOTA DE IDENTIDAD — `guid.dat`**: es la identidad IW4x del jugador (de la que deriva su GUID). El launcher la sincroniza **por cuenta**; restaurarla en una PC nueva hace que el jugador conserve SU MISMO GUID. **Nunca la sobrescribas con la de otra cuenta ni la compartas entre cuentas** (moverla entre cuentas = robo/sustitución de identidad de juego).

**Reglas del contrato:**

- El flush del `.stat` ocurre al FIN DE RONDA: **el PUT solo es válido con el juego CERRADO**. Verificarlo es responsabilidad del launcher (esperar muerte del proceso `iw4x.exe` antes de subir).
- Cada archivo viaja con su `sha256`; el server **recalcula** el hash y rechaza con `400 SHA_MISMATCH` si no coincide.
- Caps por PUT: 256 KB (string base64) por archivo, máximo 24 archivos, máximo 1 snapshot por ruta (sin duplicados).
- Snapshots versionados por timestamp (`version` = ms epoch). Se conservan las **últimas 10 versiones** por cuenta (poda automática en cada PUT).
- Si el PUT tiene exactamente los mismos archivos (todos los sha256 iguales) que la versión latest → `200 {saved:false, reason:"unchanged"}`, NO se crea versión nueva.
- Storage en servidor: `PROFILE_STORAGE_DIR` (default `<repo>/apps/api/storage/profiles`), layout `<dir>/<userId>/<version>-<combinedSha256>/...` + `latest.json`. Escritura atómica (tmp+rename).

### `GET /api/profile/save` 🔒 — manifiesto del último save

Si la cuenta **nunca subió**, responde `200 { "exists": false }` (NO 404: para el launcher "primera vez en este PC" es un caso normal del flujo pre-launch).

Response **200** (con save):

```json
{
  "exists": true,
  "version": 1770000000000,
  "updatedAt": "2026-11-07T12:00:00.000Z",
  "build": "iw4x-r4783",
  "files": [
    { "path": "iw4x.stat", "sha256": "<64 hex>", "size": 8388, "updatedAt": "2026-11-07T12:00:00.000Z" },
    { "path": "iw4x_config.cfg", "sha256": "<64 hex>", "size": 14340, "updatedAt": "2026-11-07T12:00:00.000Z" },
    { "path": "mods/mpu_iw4x/iw4x.stat", "sha256": "<64 hex>", "size": 8388, "updatedAt": "2026-11-07T12:00:00.000Z" }
  ]
}
```

### `PUT /api/profile/save` 🔒 — subir snapshot (juego cerrado)

Request:

```json
{
  "build": "iw4x-r4783",
  "files": [
    { "path": "iw4x.stat", "dataBase64": "<base64 ≤ 256KB>", "sha256": "<64 hex del contenido decodificado>" },
    { "path": "iw4x_config.cfg", "dataBase64": "...", "sha256": "..." }
  ]
}
```

Errores: `400 VALIDATION_ERROR` (path fuera de whitelist — incluye todo intento de traversal `../`, absolutos y backslashes —, >12 archivos, base64 >256KB, ruta duplicada), `400 SHA_MISMATCH` (hash declarado ≠ contenido real).

Response **200** (nuevo snapshot):

```json
{ "saved": true, "version": 1770000000000, "updatedAt": "2026-11-07T12:00:00.000Z", "files": [{ "path": "iw4x.stat", "sha256": "...", "size": 8388, "updatedAt": "..." }], "pruned": 1 }
```

Response **200** (idéntico al latest, no crea versión): `{ "saved": false, "reason": "unchanged", "version": ..., "updatedAt": ..., "files": [...], "pruned": 0 }`

### `GET /api/profile/save/file?path=iw4x.stat&version=<ts opcional>` 🔒 — bajar binario

- Sin `version` → la latest. Con `version` → esa versión exacta (rollback/diagnóstico).
- `path` debe estar en la whitelist (mismo regex que el PUT).
- Respuesta: **binario** (`Content-Type: application/octet-stream`) con headers `X-Save-Sha256` (hash del body) y `X-Save-Version`.
- Errores: `400 VALIDATION_ERROR` (path inválido), `404 SAVE_NOT_FOUND` (nunca subió), `404 SAVE_VERSION_NOT_FOUND` (versión podada/inexistente), `404 SAVE_FILE_NOT_FOUND` (ese path no está en esa versión).

### `GET /api/profile/save/versions` 🔒 — historial de versiones (diagnóstico)

Response **200** (nueva primero; máximo 10):

```json
{
  "versions": [
    { "version": 1770000000000, "updatedAt": "2026-11-07T12:00:00.000Z", "build": "iw4x-r4783", "files": [{ "path": "iw4x.stat", "sha256": "...", "size": 8388, "updatedAt": "..." }] }
  ]
}
```

### Flujo recomendado para el launcher

1. **Pre-launch**: `GET /api/profile/save` → si `exists:true`, comparar con el save local (hash local vs `files[].sha256`). Si el server es MÁS NUEVO que el local (`updatedAt` del server > mtime del local) y los hashes difieren → **conflicto explícito**: preguntar al jugador "¿Descargar progreso del servidor (X) o subir tu progreso local (Y)?". Nunca sobrescribir silenciosamente.
2. **Download**: `GET /api/profile/save/file?path=...` por cada archivo del manifiesto, verificar `X-Save-Sha256` contra el body recibido, escribir SOLO con el juego cerrado. **Destino por path** (no todos viven en el mismo lugar):
   - `guid.dat` → `%LOCALAPPDATA%\iw4x\guid.dat` (⚠️ identidad: solo se restaura si el jugador confirma; nunca mezclar entre cuentas).
   - `iw4x.stat`, `iw4x_config.cfg` → `players\`.
   - `mods/<mod>/...` → `players\mods\<mod>\`.
3. **Post-sesión**: esperar que el proceso del juego muera (el flush del `.stat` es al fin de ronda), recalcular sha256 de cada archivo local (incluye `guid.dat` y `mods/<mod>/iw4x_config.cfg`), `PUT /api/profile/save`.
4. Si el PUT responde `saved:false, reason:"unchanged"` → no pasó nada, normal.

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

### `GET /api/admin/alias-conflicts` 🔒 ADMIN

**Anti-confusión de identidades (read-only, sin acciones automáticas).** Comunidad con varias personas compartiendo PCs: detecta los DOS tipos de conflicto entre GUIDs y displayName.

1. **`nameCollisions`**: un mismo displayName (comparación case-insensitive sobre el nombre LIMPIO, sin códigos `^X`) usado por **≥2 GUIDs distintos**. Ordenado por gravedad: primero `severity: "high"` = grupos donde **≥2 guids están linked a cuentas DISTINTAS** (dos personas reales peleándose el mismo alias); dentro de cada nivel, más cuentas implicadas y más guids primero.
2. **`sharedGuids`**: un mismo GUID con **≥2 alias históricos distintos ≠ nombre actual** (señal de perfil compartido o renombrado en la misma PC).

Response **200**:

```json
{
  "nameCollisions": [
    {
      "nameKey": "snake",
      "displayName": "Snake",
      "distinctAccounts": 2,
      "severity": "high",
      "guids": [
        {
          "guid": "13352019364823201036",
          "name": "Snake",
          "linked": true,
          "linkedAccountId": 3,
          "linkedEmail": "a@test.local",
          "isBot": false,
          "lastSeenAt": "2026-11-07T02:27:33.838Z",
          "occurrences": 9
        },
        {
          "guid": "794603859254181889",
          "name": "Snake^7",
          "linked": false,
          "linkedAccountId": null,
          "linkedEmail": null,
          "isBot": true,
          "lastSeenAt": "2026-11-06T22:00:00.000Z",
          "occurrences": 4
        }
      ]
    }
  ],
  "sharedGuids": [
    {
      "guid": "794603859254181893",
      "name": "/dev/sr0",
      "linked": true,
      "isBot": true,
      "aliasCount": 3,
      "aliases": [
        { "name": "/dev/../", "firstSeenAt": "...", "lastSeenAt": "...", "occurrences": 2 },
        { "name": "Snake", "firstSeenAt": "...", "lastSeenAt": "...", "occurrences": 1 }
      ]
    }
  ],
  "generatedAt": "2026-11-07T02:50:28.429Z"
}
```

Notas para el frontend (vista `/admin`):

- `nameKey`: clave normalizada (`cleanName` sin `^X`, lowercase). `displayName`: nombre EXACTO más reciente del grupo (para pintar).
- `guids[]` del collision: por guid, `name` exacto más reciente con esa clave, `occurrences` SUMA de todas las variantes del nombre para ese guid.
- `linkedEmail` SOLO existe aquí (endpoint ADMIN). `linkedAccountId` = id numérico de la cuenta.
- `isBot` es heurística por rango de GUID (`0xb07…`, 15 chars hex): los bots del server rotan nombres de una POOL cada partida → generan MUCHAS colisiones y multi-alias FALSOS (ruido esperado). Filtra/colapsa `isBot: true` detrás de un toggle para no ahogar los conflictos reales entre humanos.
- `severity: "high"` requiere cuentas DISTINTAS (2 personas reales); la misma cuenta linked a 2 guids con el mismo nombre es `low` (PC compartida declarada, no es conflicto).
- `sharedGuids.aliases`: máx 10, orden `lastSeenAt` desc; `aliasCount` cuenta claves limpias distintas (puede exceder 10).
- Nombres sin identidad (`""`, `unknown`) nunca generan conflictos.

Errores: `401` sin token, `403` sin rol ADMIN.

#### Bootstrap del historial (`npm run rebuild:aliases`)

La tabla `PlayerAlias` se llena EN VIVO durante la ingesta del games_mp.log (líneas `J` y `K`). Para datos ya existentes corre `npm run rebuild:aliases`:

- **Pasada A**: siembra el nombre actual de cada `Player` (occurrences ≈ `connections`, fechas first/lastConnection) y fija `Player.isBot` según el rango de guids de bots.
- **Pasada B**: si `GAME_LOG_PATH` es accesible, re-escanea el log CRUDO desde el byte 0 y recupera nombres HISTÓRICOS (renombres) que ya no son el nombre actual. Ni `KillEvent` ni `Session` guardan nombres (solo guids), así que el log crudo es la única fuente de historial.
- Es **IDEMPOTENTE**: todas las escrituras son monótonas (max/min o set absoluto) → re-ejecutar no infla `occurrences` ni regresa fechas.

### `GET /api/admin/identity-alerts?status=&limit=` 🔒 ADMIN

**Alertas de identidad (anti-impersonación de nick registrado).** Cuando un GUID que NO está vinculado al dueño usa en el juego el displayName RESERVADO de una cuenta web, la ingesta del log (línea `J`) crea/actualiza una alerta. Read-only en la detección; resolución manual.

**Regla exacta** (rama `connect` de la ingesta): SÍ alerta si (a) `cleanName(name)` coincide con el `displayNameNormalized` de UN user, (b) el guid NO está en los AccountLink de ESE user (sus PCs declaradas nunca alertan), y (c) el guid NO es bot (`0xb07…`; los bots re-usan la pool de nombres constantemente). Caso borde: guid linked a OTRO user ≠ owner → SÍ alerta (impersonación clásica). Dedupe: una sola fila `OPEN` por (guid, ownerUserId); si ya estaba RESOLVED/DISMISSED, un nuevo uso crea una alerta NUEVA.

Query params: `status` opcional (`OPEN` | `RESOLVED_OWNER` | `RESOLVED_IMPOSTOR` | `DISMISSED`; sin él devuelve todas), `limit` 1–200 (default 100), orden `lastSeenAt` desc.

Response **200**:

```json
{
  "alerts": [
    {
      "id": 1,
      "guid": "13352019364823201036",
      "name": "MiTag",
      "status": "OPEN",
      "firstSeenAt": "2026-11-07T03:00:00.000Z",
      "lastSeenAt": "2026-11-07T06:30:00.000Z",
      "occurrences": 4,
      "owner": {
        "id": 2,
        "email": "player@example.com",
        "displayName": "MiTag",
        "linkedGuids": ["263534314041025950"]
      },
      "ownerLinkedGuidsSnapshot": ["263534314041025950"]
    }
  ],
  "counts": { "OPEN": 1, "RESOLVED_OWNER": 0, "RESOLVED_IMPOSTOR": 0, "DISMISSED": 0 },
  "total": 1
}
```

- `owner.linkedGuids`: guids vinculados ACTUALES del dueño (para decidir el resolve). `ownerLinkedGuidsSnapshot`: guids del dueño al momento de detectarse (histórico).
- `RESOLVED_IMPOSTOR` existe como estado reservado; hoy no lo escribe ningún endpoint.

Errores: `401`, `403`, `400 VALIDATION_ERROR` (status fuera del enum).

### `POST /api/admin/identity-alerts/:id/resolve` 🔒 ADMIN

Body: `{ "action": "LINK_TO_OWNER" | "DISMISS" }`

- **`LINK_TO_OWNER`**: crea `AccountLink(owner, guid)` (si el guid está libre) y marca `RESOLVED_OWNER`. Si el guid ya está vinculado a OTRA cuenta → `409 GUID_ALREADY_LINKED` con explicación (resolver manualmente; revisa al imposter con `GET /api/admin/iam/clients`).
- **`DISMISS`**: marca `DISMISSED` (falso positivo / PC compartida declarada). 
- Re-resolver una alerta no-OPEN → `409 ALERT_ALREADY_RESOLVED`. Alerta inexistente → `404 NOT_FOUND`.

**"Castigar al impostor" NO es un endpoint nuevo**: el frontend compone el castigo con `POST /api/admin/iam/penalty` (bridge IW4MAdmin existente) contra el clientId del imposter, y luego llama este resolve con `DISMISS` para cerrar la alerta.

Errores: `400 VALIDATION_ERROR`, `401`, `403`, `404`, `409 GUID_ALREADY_LINKED` / `409 ALERT_ALREADY_RESOLVED`.

#### Bootstrap de alertas (`npm run rebuild:identity`)

Pipeline idempotente en orden: normaliza `User.displayNameNormalized` para usuarios existentes (colisiones históricas → sufijo `-2`/`-3` reportado, el displayName visible NO cambia) → `rebuildAliases` (alias + `isBot`) → siembra `IdentityAlert` históricas desde `PlayerAlias` con las mismas reglas de la ingesta. Re-ejecutar no duplica.

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
| `includeBots` | `true` \| `false` (default **false**: el ranking público es SOLO-humanos; los bots están marcados con `Player.isBot` y excluidos) |

> Los bots (guids del rango `0xb07…`) quedan fuera del leaderboard por defecto en TODOS los sorts (incluido `sort=skill`). Con `includeBots=true` vuelven a aparecer. Si el frontend necesita una vista "con bots", pásale el param y rotúlalo.

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
      "skill": 1042.5,
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
      "skill": 1187.25,
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
    "skill": 1042.5,
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
- `aliases` (anti-confusión): nombres HISTÓRICOS vistos para este GUID en el games_mp.log (líneas J y K). Excluye el nombre actual (`player.name`), ordenado por `lastSeenAt` desc, máximo 10. `occurrences` = apariciones acumuladas (J + K). Array vacío si el guid siempre usó el mismo nombre. Útil para detectar PCs compartidas o renombres: si el leaderboard muestra dos filas con el mismo displayName (son 2 entidades/GUIDs distintas, es verdad), el perfil con `aliases` desambigua quién es quién.

```json
"aliases": [
  { "name": "AlphaOld", "firstSeenAt": "2026-11-06T21:00:00.000Z", "lastSeenAt": "2026-11-07T01:30:00.000Z", "occurrences": 4 }
]
```

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

## skill (ELO real por eventos)

`skill` sigue siendo un `number` en leaderboard/perfil/players/:guid (shape sin cambios), pero ya NO es una heurística por agregados: es **ELO calculado sobre KillEvents** (fuente única de stats = log / IW4MAdmin; IW4MAdmin NUNCA escribe en esta DB). Implementación: `apps/api/src/services/skill/`.

Fórmula resumida (constantes en `apps/api/src/services/skill/elo.ts`):

- Cada kill mueve puntos del atacante a la víctima ponderado por fuerza relativa (expected-score clásico, escala 400): `delta = K_medio × mult × (1 − expected)`. Zero-sum por evento.
- `K` decrece con el skill (los novatos se mueven más): 40 (< 1150), 30 (1150–1600), 24 (> 1600).
- `mult` (bonus del atacante): headshot ×1.25; hitloc difícil (`neck`) ×1.1; daño sobre 100: +1% cada 10 dmg, cap +25%. Combinación acotada por 1.6 (guard).
- Teamkill: penalidad plana de 24 al atacante (la víctima no gana nada → sin farming de compañeros).
- World/suicidio (defensivo; la ingesta por log no almacena estos eventos): pérdida plana de 4.
- ELO base con **floor 150** y **cap 2500**; start 1000. Determinista: mismo set de eventos en el mismo orden (`timeEpoch ASC, id ASC`) → mismo skill.
- Valor expuesto: `skill = skillElo + bonus de racha` (+2 por kill de la mejor racha, cap racha 20 → máximo +40). **Rango típico expuesto: ~150–2540**, con la mayoría de la población entre ~850 y ~1600 (útil para el tooltip del frontend).

Procesamiento **incremental e idempotente**: cada sync aplica SOLO los KillEvent con `skillProcessed = false` (los nuevos), en orden cronológico, y los marca en la misma transacción (lotes de 2000). Los players sin eventos se inicializan a 1000.

Recompute FROM SCRATCH (tras un reset de DB o recalibración del modelo): `npm run recompute:skill` desde la raíz del monorepo — desmarca TODOS los eventos, resetea `skillElo` y reprocesa el histórico completo en orden. El bootstrap de datos previos al deploy fue automático: los eventos existentes quedaron con `skillProcessed=false` por default y el primer sync los procesó todos.

BOTS (`+spawnBot`): el guid literal `botN` que escribe el engine en games_mp.log se mapea DETERMINISTA a un guid del rango dedicado `0xb07…` → cada bot tiene perfil estable que acumula stats y participa del ELO como cualquier player.

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

## Moderación NATIVA (RCON IW4x) — `/api/admin/iam/*` 🔒 ADMIN

> **Vecinos: NO duplicar stats ni perfiles.** El ranking/leaderboard/perfiles se alimenta del log del juego (`games_mp.log`). Esta sección es EXCLUSIVAMENTE moderación: penalidades y control en vivo del server. Nada de lo que consumas acá debe usarse para stats.

**SIN IW4MAdmin**: la moderación habla DIRECTO con el server dedicado IW4x por **RCON UDP** (protocolo Quake: `FF FF FF FF rcon <password> <cmd>`, latin1; respuestas `print\n`; `getinfo <challenge>` sin auth). El historial vive en **NUESTRA DB** (tabla `Penalty` de Prisma). El ban permanente del juego se persiste en `userraw/bans.json` (escrito SOLO por el server vía `banClient`/`unbanClient`; el panel lo LEE si `RCON_BANS_FILE` apunta a él).

**Config (env de `apps/api/.env`)**:

| Variable | Obligatoria | Para qué |
| --- | --- | --- |
| `RCON_HOST` / `RCON_PORT` | No (default `127.0.0.1:28961`) | UDP del server dedicado. |
| `RCON_PASSWORD` | **Sí** | El MISMO valor de `rcon_password` del server.cfg. Sin esto: `503 MODERATION_NOT_CONFIGURED` y el enforcer no arranca. |
| `RCON_SPACING_MS` | No (default 200) | Spacing entre comandos: el server throtea (`rcon_timeout=100`) con drop silencioso. |
| `RCON_RESPONSE_TIMEOUT_MS` | No (default 1200) | Timeout por intento. Las LECTURAS reintentan con backoff (el server a veces tarda >1s); las ESCRITURAS **jamás** se reintentan. |
| `RCON_ENFORCER_INTERVAL_MS` | No (default 30000) | Intervalo del enforcer (ver abajo). |
| `RCON_BANS_FILE` | No | Path a `userraw/bans.json` para listar bans del juego (SOLO lectura). |

**Enforcer** (`RCON_ENFORCER_INTERVAL_MS`): el juego NO tiene tempban per-caso por minutos (`tempBanClient` usa el dvar GLOBAL `sv_kickBanTime`) y `banClient` exige al jugador conectado. Por eso tempban/ban offline viven en nuestra DB y el enforcer hace `status()` cada tick y `clientkick` a cualquier guid con penalidad activa que esté conectado. Al expirar el tempban el jugador vuelve solo (la fila se marca inactive).

Todos los endpoints exigen **JWT + rol ADMIN** (misma rama que `PUT /api/admin/server-config`). El admin del JWT queda registrado como `punisher` de cada penalidad.

### `GET /api/admin/iam/status` 🔒 ADMIN

Diagnóstico (NO devuelve 502 si el server está caído: siempre 200 con `error` legible).

```json
{
  "configured": true,
  "reachable": true,
  "penaltiesDb": { "configured": true },
  "error": null,
  "servers": [
    {
      "id": 12700128961,
      "name": "^7[^1RANKING^7] ^7Local Test Server E2E",
      "game": "IW4",
      "map": "mp_terminal",
      "gametype": "war",
      "players": 2,
      "maxPlayers": 18,
      "parser": "IW4x RCON"
    }
  ]
}
```

- `penaltiesDb.configured` es SIEMPRE `true` (el historial es nuestra DB; ya no depende de una SQLite externa).
- Errores: `200` siempre; `error` describe la env que falta o el fallo rcon.

### `GET /api/admin/iam/clients?query=<nombre|guid>` 🔒 ADMIN

Búsqueda en **la base del ranking** (Player + PlayerAlias): nombre LIKE limpio (≥3 chars, ignora `^X` y case) o **guid** (hex 16 del status o decimal del ranking). `level` = `"Banned"` solo si tiene ban activo (no hay niveles nativos). `openPenalties` SIEMPRE disponible (nuestra DB).

```json
{
  "total": 1,
  "query": "toxicplayer",
  "penaltiesDb": true,
  "clients": [
    {
      "clientId": 5,
      "name": "^1Toxic^7Player",
      "xuid": "12345678901234567",
      "level": "Banned",
      "openPenalties": [
        {
          "id": 12,
          "type": "ban",
          "reason": "cheating (permban)",
          "automated": false,
          "when": "2026-11-07T18:00:00.000Z",
          "expires": null,
          "active": true,
          "source": "panel",
          "offender": { "clientId": 5, "guid": "12345678901234567", "name": "ToxicPlayer" },
          "punisher": { "clientId": 1, "name": "Mod Admin" }
        }
      ]
    }
  ]
}
```

- `clientId` = `Player.id` del ranking (sirve para POST penalty online y offline).
- Errores: `400 VALIDATION_ERROR` (query corta), `403 FORBIDDEN`.

### `GET /api/admin/iam/penalties?limit=30` 🔒 ADMIN

Historial desde **NUESTRA DB** (warn/kick/tempban/ban/unban), más nuevo primero. `limit` entre 1 y 100 (default 30). Cada entrada usa el mismo shape de `openPenalties` (arriba). Sin 503: la DB es propia.

### `POST /api/admin/iam/penalty` 🔒 ADMIN

Emite una penalidad NATIVA por rcon + registra `Penalty` en nuestra DB.

Request:

```json
{
  "type": "tempban",
  "durationMinutes": 90,
  "reason": "exploit en CTF",
  "clientId": 9
}
```

| Campo | Regla |
| --- | --- |
| `type` | `warn` \| `kick` \| `tempban` \| `ban` |
| `reason` | **Obligatorio** (≥3 y ≤200) — viaja al juego (`tell`) y queda en la DB |
| `clientId` | `Player.id` del ranking: ONLINE (resuelve el slot por guid) u OFFLINE (solo tempban/ban → enforcer) |
| `clientName` | Match EXACTO limpio contra los CONECTADOS; ambiguo → 400 pidiendo clientId/cid |
| `cid` | **Nuevo**: slot directo de `status` (num). Útil para bots (sin Player en la base) |
| `durationMinutes` | Solo `tempban`: 1..43200 → `clientkick` inmediato + `Penalty.expiresAt` (per-caso REAL; el enforcer re-kickea al conectar) |

Reglas de negocio:

- **Anti-TOCTOU**: antes de cada escritura con slot se RE-LÉE `status` y se verifica que el cid sigue teniendo el guid objetivo; si cambió → `409 CID_MISMATCH` y NINGÚN comando.
- **Bots**: `warn`/`tempban`/`ban` → `403 TARGET_IS_BOT`; `kick` SÍ (liberar slots).
- warn → `tell <cid> "<razón>"`; kick → `clientkick <cid>`; ban online → `banClient <cid>` (persistente en bans.json); ban/tempban offline → solo DB + enforcer.

Response **200**:

```json
{
  "executed": true,
  "type": "tempban",
  "clientId": 9,
  "serverId": 12700128961,
  "output": ["penalty#42", "clientkick 3 (tempban 90m)"]
}
```

Errores:
- `400 VALIDATION_ERROR` — motivo corto, tempban sin `durationMinutes`, sin target, warn/kick offline.
- `403 TARGET_IS_BOT` — warn/tempban/ban a un bot.
- `404 MODERATION_TARGET_NOT_FOUND` — `clientId` inexistente o nombre sin match exacto.
- `409 CID_MISMATCH` — el slot rotó entre lectura y acción (anti-TOCTOU).
- `502 MODERATION_UNREACHABLE` — el server no respondió por rcon (password/throttle/caído).
- `503 MODERATION_NOT_CONFIGURED` — falta `RCON_PASSWORD`.

### `POST /api/admin/iam/unban` 🔒 ADMIN (NUEVO)

Revoca el ban permanente: `unbanClient guid <HEX uppercase>` (bans.json del server) + marca nuestras `Penalty` activas (ban/tempban) como revocadas y registra la entrada `unban`.

```json
{ "clientId": 9 }        // Player.id del ranking
{ "guid": "0B08D9C7F6A1B234" }  // HEX (formato status/bans.json) o decimal
{ "cid": 3 }             // slot conectado
```

Response: mismo shape de `POST /penalty` con `type: "unban"`; `output` incluye el HEX usado (ej. `"unbanClient guid 0B08D9C7F6A1B234"`).

### `GET /api/admin/iam/bans` 🔒 ADMIN (NUEVO)

Lee `userraw/bans.json` del server (SOLO lectura; `RCON_BANS_FILE`). Sin la env → `configured:false` con lista vacía; archivo inexistente (aún sin bans) → `exists:false`.

```json
{
  "configured": true,
  "exists": true,
  "file": "D:/Call of Duty 6/userraw/bans.json",
  "bans": [
    { "kind": "ip", "value": "192.168.3.66", "guidDecimal": null },
    { "kind": "guid", "value": "0B08D9C7F6A1B234", "guidDecimal": "795124787090403892" }
  ]
}
```

### `GET /api/admin/iam/live` 🔒 ADMIN

Jugadores conectados AHORA: `status()` + `getinfo()` combinados por rcon.

```json
{
  "servers": [
    {
      "id": 12700128961,
      "name": "^7[^1RANKING^7] ^7Local Test Server E2E",
      "online": true,
      "map": "mp_terminal",
      "gametype": "war",
      "players": [
        {
          "name": "^1Toxic^7Player",
          "clientId": 5,
          "clientNumber": 0,
          "guid": "12345678901234567",
          "isBot": false,
          "connecting": false,
          "level": null,
          "ping": 30,
          "score": 1250,
          "state": "Connected"
        }
      ]
    }
  ]
}
```

- `clientId` = `Player.id` si el guid está en nuestra base (sync del log cada 30s); `null` si aún no (el frontend debe tolerarlo). `guid` es decimal (formato ranking) o `botN` para bots.
- `clientNumber` (slot/cid) SIEMPRE presente — para acciones directas (bots incluidos: kick por `cid`).
- `?resolve=false` evita la resolución contra la DB (`clientId` queda `null`).
- Errores: `403`, `502 MODERATION_UNREACHABLE`, `503 MODERATION_NOT_CONFIGURED`.

### Notas para el frontend de moderación

- `clients`, `penalties`, `bans` y `live` son consultas read-only; `POST /penalty` y `POST /unban` son los únicos con side effect. Confirma siempre el motivo y pide confirmación en tempban/ban.
- `name` puede contener códigos de color (`^1RANKING`): sácalos con `/\^[0-9a-zA-Z]/g` (un solo carácter tras `^`).
- Errores: revisar `error.code` (nunca mensaje humano) para decidir qué alerta mostrar.
- NO usar estos endpoints para enriquecer stats/perfiles del leaderboard: es un canal aparte (ver nota arriba).
- Para kickear bots desde el panel: `POST /penalty` con `cid` (los bots no tienen `clientId` resuelto).

---

## Resumen rápido de rutas

| Método | Ruta                      | Auth | Descripción |
| ------ | ------------------------- | ---- | ----------- |
| GET    | `/api/health`             | —    | Estado del servicio |
| POST   | `/api/auth/register`      | —    | Registro (devuelve JWT; role USER/ADMIN según ADMIN_EMAILS) |
| POST   | `/api/auth/login`         | —    | Login SOLO por nick (`identifier` = displayName; campo legacy `email` aceptado con el mismo tratamiento). El email NO es credencial |
| GET    | `/api/auth/me`            | ✅   | Usuario + `role` + `linkedGuid` (legacy) + `linkedGuids[]` con metadatos |
| PATCH  | `/api/auth/me`            | ✅   | Cambiar `displayName` y/o `password` (valida la actual) |
| POST   | `/api/link/start`         | ✅   | Registra intento de vinculación |
| POST   | `/api/link/complete`      | ✅   | Sin `guid` → candidatos; con `guid` → vincula (MULTI-GUID) |
| DELETE | `/api/link/:guid`         | ✅   | Desvincular un GUID propio |
| GET    | `/api/leaderboard`        | —    | Ranking paginado/filtrable (SOLO-humanos por defecto; `includeBots=true` para ver bots) |
| GET    | `/api/players/:guid`      | —    | Perfil ampliado + `rank` global + eventos recientes + por servidor + `aliases` históricos |
| GET    | `/api/players/:guid/history` | — | Serie temporal por día |
| GET    | `/api/players/:guid/weapons` | — | Desglose por arma del jugador + favorita |
| GET    | `/api/players/:guid/maps`    | — | Desglose por mapa del jugador + favorito |
| GET    | `/api/weapons`            | —    | Ranking global de armas (kills/damage/victims/headshots) |
| GET    | `/api/servers`            | —    | Lista de servers conocidos (env `SERVERS` o derivada) |
| GET    | `/api/profile/save`       | ✅   | Manifiesto del último cloud save (`{exists:false}` si nunca subió) |
| PUT    | `/api/profile/save`       | ✅   | Subir snapshot del save (juego CERRADO; valida sha256, caps y whitelist; poda a 10 versiones) |
| GET    | `/api/profile/save/file`  | ✅   | Bajar binario (`?path=` whitelist, `?version=` opcional; header `X-Save-Sha256`) |
| GET    | `/api/profile/save/versions` | ✅ | Historial de versiones retenidas (máx 10) |
| POST   | `/api/sync`               | ✅   | Dispara sincronización (combina IW4MAdmin y/o games_mp.log) |
| GET    | `/api/sync/status`        | —    | `{lastSyncAt, configured, intervalMinutes, windowMinutes}` (público) |
| GET    | `/api/admin/server-config` | ADMIN | Parsea el server.cfg real a estructura JSON |
| PUT    | `/api/admin/server-config` | ADMIN | Regenera el cfg (backup + escritura atómica; restart opcional) |
| POST   | `/api/admin/server/restart` | ADMIN | Reinicia el server (requiere ALLOW_SERVER_CONTROL=1) |
| GET    | `/api/admin/alias-conflicts` | ADMIN | Anti-confusión: colisiones de nombre entre GUIDs + guids con múltiples alias (read-only) |
| GET    | `/api/admin/identity-alerts` | ADMIN | Alertas de identidad: guid ajeno usando un nick registrado (filtro `?status=`, read-only) |
| POST   | `/api/admin/identity-alerts/:id/resolve` | ADMIN | `LINK_TO_OWNER` (vincula el guid al dueño) o `DISMISS`; el castigo al impostor va por `/iam/penalty` |
| GET    | `/api/admin/iam/status`    | ADMIN | Diag del bridge IW4MAdmin (config/reachability/servers) |
| GET    | `/api/admin/iam/clients`   | ADMIN | Búsqueda de clientes con penalidades abiertas y nivel |
| GET    | `/api/admin/iam/penalties` | ADMIN | Historial reciente de warn/kick/tempban/ban/unban |
| POST   | `/api/admin/iam/penalty`   | ADMIN | Emite warn/kick/tempban/ban vía execute (`@clientId`) |
| GET    | `/api/admin/iam/live`      | ADMIN | Players conectados ahora con clientId resuelto |
