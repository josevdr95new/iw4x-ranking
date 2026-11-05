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
| `IW4MADMIN_DB_PATH`    | para sync   | Ruta a la SQLite de IW4MAdmin. Se abre **SIEMPRE read-only** |
| `SYNC_INTERVAL_MINUTES`| no (0)      | `> 0` activa sync automática cada N minutos |
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

> ⚠️ Si **regeneras** el mock, borra también `apps/api/prisma/dev.db` y repite `db:push` + `sync`: el cursor incremental de kill events (`SyncState`) asume una fuente que solo crece.

Smoke test end-to-end (con el server corriendo y datos sincronizados):

```powershell
npm run smoke       # 14 checks: auth, sync, leaderboard, perfil, historial, vinculación
```

## 4B. Conectar un IW4MAdmin real

1. Localiza la base de IW4MAdmin: `<carpeta de IW4MAdmin>/Database/Database.sqlite`.
2. Ponla en `apps/api/.env`:

```ini
IW4MADMIN_DB_PATH=C:/IW4MAdmin/Database/Database.sqlite
```

3. Corre `npm run sync` (o `POST /api/sync` autenticado) y revisa el campo `warnings` del resultado.

**Seguridad del sync:**

- La fuente se abre con better-sqlite3 en modo `readonly: true` + `fileMustExist: true` → **la API nunca escribe en la DB de IW4MAdmin**.
- Antes de consultar, lee el esquema real con `PRAGMA table_info` de `EFClient`, `EFClientKill` y `EFServer`; solo usa columnas presentes (`CurrentName ?? Name`, `IsKill`, `Damage`, `Weapon`, `ServerId`, … opcionales).
- Cada tabla corre en try/catch: si falta algo esencial se registra en `warnings` y el sync continúa con datos parciales (nunca rompe).
- Formatos tolerados en fechas: TEXT ISO-8601 (`2024-05-01T12:00:00Z`, con espacio, sin zona) y epoch numérico (segundos o ms).
- `NetworkId` se lee con `safeIntegers: true` (BigInt) y se almacena como string decimal — soporta GUIDs de 64 bits sin pérdida.
- Agregaciones (kills/deaths/K/D/tiempo/conexiones/skill) se recalculan completas en cada sync con `GROUP BY`; los kill events individuales se importan **incrementalmente** (`Time > último epoch sincronizado`), por lo que re-sincronizar es barato.

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

Vitest (36 tests): auth (registro/login/me/validaciones), sync defensivo con DB mock determinista (agregaciones, incrementalidad), leaderboard (orden/búsqueda/paginación/minMatches), perfil, historial y flujo completo de vinculación GUID. Los tests usan su propia SQLite (`apps/api/prisma/test.db`) y su propio mock (`apps/api/tests/data/`), nunca tu `dev.db`.

## 7. Frontend

`apps/web` está reservado (placeholder). El contrato exacto de endpoints está en [`docs/API.md`](API.md). La API ya tiene CORS habilitado para `http://localhost:5173`.

## Problemas comunes

| Síntoma | Causa / solución |
| ------- | ---------------- |
| `503 SYNC_NOT_CONFIGURED` | Falta `IW4MADMIN_DB_PATH` en `apps/api/.env` (o el archivo `.env` no existe) |
| `503 SYNC_SOURCE_UNAVAILABLE` | Ruta incorrecta o archivo bloqueado; usa barras normales en el path |
| `sync` con `warnings` de columnas | Versión de IW4MAdmin con esquema distinto: es comportamiento defensivo; revisa qué columnas lista el warning |
| Leaderboard vacío | No corriste `npm run sync` después de crear/mock la DB |
| `link/complete` devuelve 0 candidatos | El jugador no se conectó en los últimos `LINK_WINDOW_MINUTES` minutos, o no hubo sync desde entonces |
| Tokens se invalidan al reiniciar | `JWT_SECRET` no configurado en dev (se genera efímero); configúralo |
