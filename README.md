# IW4x Ranking

Sistema de ranking web para una comunidad de **IW4x (CoD: MW2 2009)**. Sincroniza estadísticas de jugadores desde la base de datos de **IW4MAdmin**, calcula agregaciones (kills, deaths, K/D, tiempo jugado, skill) y expone una API REST con aut JWT, leaderboard, perfiles y vinculación de cuenta web ↔ GUID del juego.

## Stack

- **Monorepo** npm workspaces (`apps/api`, `apps/web`)
- **API**: Node.js + TypeScript + Express, ESM estricto
- **DB**: Prisma + SQLite (nuestra DB) y better-sqlite3 **read-only** para leer la DB de IW4MAdmin
- **Auth**: JWT (jsonwebtoken + bcryptjs), validación con zod

## Estructura

```
iw4x-ranking/
├── apps/
│   ├── api/          # API REST (implementada)
│   │   ├── prisma/   # schema + dev.db
│   │   ├── src/      # routes / services / sync / middleware / lib
│   │   └── tests/    # vitest (auth + sync/agregaciones)
│   └── web/          # frontend (placeholder — se implementa aparte)
├── docs/             # API.md (contrato), SETUP.md (instalación)
├── scripts/          # mock-iw4madmin.ts, smoke-api.ts
└── Database/         # (generada) SQLite mock estilo IW4MAdmin
```

## Quickstart

```powershell
npm install
Copy-Item .env.example apps/api/.env      # editar IW4MADMIN_DB_PATH
npm run db:push                           # crea el esquema Prisma
npm run mock:db                           # genera Database/Database.sqlite (~50 jugadores demo)
npm run sync                              # sincroniza mock → Prisma
npm run dev:api                           # http://localhost:3000
```

## Scripts útiles

| Comando          | Descripción                                            |
| ---------------- | ------------------------------------------------------ |
| `npm run dev:api`  | API en modo watch (tsx)                               |
| `npm run dev:web`  | Frontend en modo dev (vite, puerto 5173)              |
| `npm run build`    | Compila apps/api → `dist/`                            |
| `npm run start:api`| Ejecuta el build compilado                            |
| `npm run sync`     | Corre una sincronización manual (CLI)                 |
| `npm run mock:db`  | Genera la SQLite mock de IW4MAdmin                    |
| `npm run mock:refresh-connections` | Refresca `LastConnection` de 3 jugadores del mock (para probar vinculación GUID) |
| `npm run test`     | Tests (vitest)                                        |
| `npm run smoke`    | Prueba de humo end-to-end contra la API corriendo     |

## Documentación

- [`docs/API.md`](docs/API.md) — contrato exacto de endpoints (para el frontend)
- [`docs/SETUP.md`](docs/SETUP.md) — instalación, env vars, IW4MAdmin real
