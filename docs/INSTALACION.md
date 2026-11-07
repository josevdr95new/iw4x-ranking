# Instalación desde cero (primera instalación)

Guía para levantar el sistema desde un clon fresco del repositorio. Al final
tendrás la API corriendo con un **admin por defecto** listo para entrar, y una
base de datos **limpia** (sin datos de prueba).

## Requisitos

- **Node.js >= 20** (el monorepo usa npm workspaces; no necesitas pnpm/yarn)
- Windows, Linux o macOS (los comandos de ejemplo son PowerShell; en bash son equivalentes salvo `Copy-Item` → `cp`)

## 1. Clonar e instalar

```powershell
git clone <repo> iw4x-ranking
cd iw4x-ranking
npm install        # instala workspaces + prisma generate (postinstall)
```

## 2. Configurar entorno

```powershell
Copy-Item .env.example apps/api/.env
```

Edita `apps/api/.env` y revisa como mínimo:

| Variable         | Para qué                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| `JWT_SECRET`     | Firma de tokens. Cámbialo por un secreto largo y aleatorio (>=16 chars)  |
| `GAME_LOG_PATH`  | Ruta del `games_mp.log` del server dedicado (fuente real de stats)        |
| `SERVERS`        | Lista de servers para la web/launcher (opcional)                          |

> Las demás (`IW4MADMIN_*`, `ALLOW_SERVER_CONTROL`, …) son opcionales: su
> ausencia desactiva esa funcionalidad de forma segura.

## 3. Crear la base de datos

```powershell
npm run db:push     # crea apps/api/prisma/dev.db con el esquema Prisma
```

## 4. Arrancar la API

```powershell
npm run dev:api     # http://localhost:3000 (tsx watch)
```

En el **primer arranque** (tabla User vacía) el server auto-crea el admin por
defecto y lo loguea en consola:

```
[seed] Admin por defecto creado (admin / admin123) — CAMBIA la contraseña tras el primer login.
```

- Guard: solo corre si la DB **no tiene ningún usuario**; se puede desactivar
  con `SEED_DEFAULT_ADMIN=0`.
- Para crearlo/promoverlo manualmente en cualquier momento:
  `npm run seed:admin` (idempotente: si ya existe **no** resetea su contraseña,
  solo asegura el rol ADMIN).

## 5. Entrar a la web y CAMBIAR la contraseña

- Login **SOLO por nick**: `admin` / `admin123`.
  El email (`admin@admin.com`) **NO es credencial de acceso**: es solo
  gestión/recuperación de la cuenta.
- **Cambia la contraseña de inmediato**: en la web, perfil → cambiar contraseña
  (valida la actual), o `PATCH /api/auth/me` con
  `{ currentPassword, password }`.

## 6. (Opcional) Limpiar datos de prueba

Si tu `dev.db` acumuló datos de pruebas manuales (probes, cuentas
`cloudtest-*`, `launcher-test`, etc.), hay un script re-ejecutable e
idempotente que los purga con resumen:

```powershell
npm run db:clean
```

Borra SOLO objetivos explícitos (guids TESTPROBE, emails de prueba listados en
`apps/api/scripts/clean-testdata.ts`) y sus dependencias (aliases, sesiones,
kill-events, vínculos, storage de perfil). **Nunca** toca bots, jugadores
reales del log, el admin por defecto ni cuentas ajenas. Una segunda pasada
borra 0 filas.

## Variables del admin por defecto (`.env`)

| Variable             | Default          | Nota                                   |
| -------------------- | ---------------- | -------------------------------------- |
| `ADMIN_NICK`         | `admin`          | Único identificador de login            |
| `ADMIN_EMAIL`        | `admin@admin.com`| Solo gestión de cuenta (no credencial)  |
| `ADMIN_PASSWORD`     | `admin123`       | SOLO se usa al CREAR; jamás resetea     |
| `SEED_DEFAULT_ADMIN` | `1`              | `0` desactiva el auto-seed del arranque |

## Solución de problemas

- **No puedo loguear con el email** → es esperado: el login es exclusivamente
  por nick (`displayNameNormalized`).
- **El admin no se creó al arrancar** → la tabla User ya tenía usuarios
  (el auto-seed solo actúa con DB vacía). Usa `npm run seed:admin`.
- **Puerto 3000 ocupado** → cambia `PORT` en `apps/api/.env`.
