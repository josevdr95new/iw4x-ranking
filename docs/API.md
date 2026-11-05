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
    "createdAt": "2026-11-05T22:03:18.518Z",
    "linkedGuid": "263534314041025950"
  }
}
```

`linkedGuid` es `null` hasta completar la vinculación (ver abajo). Errores: `401 UNAUTHORIZED`.

---

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
{ "status": "linked", "guid": "263534314041025950", "name": "ZombieSlayer69", "linkedAt": "2026-11-05T22:06:10.000Z" }
```

Errores: `400 VALIDATION_ERROR` (formato no numérico), `404 PLAYER_NOT_FOUND`, `409 USER_ALREADY_LINKED`, `409 GUID_ALREADY_LINKED`.

> Nota: la confirmación con `guid` exige que el GUID exista y esté libre; los candidatos ya vienen filtrados por la ventana de tiempo.

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
      "lastConnection": "2026-11-02T21:59:06.318Z"
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
      "lastConnection": "2026-10-04T21:59:06.318Z"
    }
  ]
}
```

Unidades: `timePlayed` en **segundos**; `rank` es global según la página actual. Errores: `400 VALIDATION_ERROR` (p. ej. `sort=hacks`).

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
    "firstConnection": "2026-02-27T21:59:06.318Z",
    "lastConnection": "2026-11-02T21:59:06.318Z",
    "linked": false
  },
  "recentEvents": [
    {
      "id": 8925,
      "time": "2026-11-02T06:03:37.000Z",
      "epoch": 1793599417,
      "direction": "kill",
      "isKill": true,
      "damage": 248,
      "weapon": "0",
      "server": "192.0.2.1",
      "opponentGuid": "977082674952689500",
      "opponentName": "Chopper_Gunner"
    }
  ],
  "byServer": [
    { "server": "192.0.2.3", "kills": 20, "deaths": 10 },
    { "server": "192.0.2.9", "kills": 25, "deaths": 4 }
  ]
}
```

Notas para el frontend:

- `recentEvents`: últimos 20 eventos del jugador, más reciente primero. `direction` es `kill` (el jugador fue el origen) o `death` (fue el objetivo). `isKill: false` = evento no letal registrado por IW4MAdmin.
- `weapon` es el **id crudo** (número como string) que guarda IW4MAdmin; el mapping a nombre de arma no está implementado aún.
- `server` puede ser `null` si la fuente no expone servidor (columna `ServerId` ausente en EFClientKill o tabla EFServer sin datos).
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

### `GET /api/sync/status` 🔒

Response **200**:

```json
{
  "configured": true,
  "intervalMinutes": 0,
  "windowMinutes": 10,
  "lastRun": {
    "id": 2,
    "startedAt": "2026-11-05T22:02:01.432Z",
    "finishedAt": "2026-11-05T22:02:02.042Z",
    "ok": true,
    "playersSynced": 50,
    "killEventsSynced": 0,
    "warnings": []
  },
  "runs": [ "…últimas 10 corridas, más reciente primero…" ]
}
```

`killEventsSynced: 0` en corridas posteriores = incremental sin novedades (comportamiento esperado).

---

## Resumen rápido de rutas

| Método | Ruta                      | Auth | Descripción |
| ------ | ------------------------- | ---- | ----------- |
| GET    | `/api/health`             | —    | Estado del servicio |
| POST   | `/api/auth/register`      | —    | Registro (devuelve JWT) |
| POST   | `/api/auth/login`         | —    | Login (devuelve JWT) |
| GET    | `/api/auth/me`            | ✅   | Usuario actual + `linkedGuid` |
| POST   | `/api/link/start`         | ✅   | Registra intento de vinculación |
| POST   | `/api/link/complete`      | ✅   | Sin `guid` → candidatos; con `guid` → vincula |
| GET    | `/api/leaderboard`        | —    | Ranking paginado/filtrable |
| GET    | `/api/players/:guid`      | —    | Perfil + eventos recientes + por servidor |
| GET    | `/api/players/:guid/history` | — | Serie temporal por día |
| POST   | `/api/sync`               | ✅   | Dispara sincronización |
| GET    | `/api/sync/status`        | ✅   | Estado/últimas corridas de sync |
