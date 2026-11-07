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

## Configuración — `launcher.config.json`

Se crea automáticamente junto al script (o junto al .exe compilado) con estos
defaults si no existe:

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

| Clave                   | Significado                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `api_url`               | Base de la API (el launcher añade el prefijo `/api/...`). Editable en Ajustes. |
| `game_path`             | Ruta de `iw4x.exe`. Editable en Ajustes (con selector).       |
| `servers`               | Lista de servers `{name, address}` para el dropdown.          |
| `default_server`        | Índice del server seleccionado al abrir. Editable en Ajustes. |
| `force_nick`            | **true** por defecto: fuerza el nick del ranking en el juego (`+set name <displayName>` antes de `+connect`). Editable en Ajustes ("Forzar mi nick del ranking en el juego"). Si la cuenta no tiene displayName, el juego abre con su nick guardado (se avisa en la consola). |
| `simulate_game`         | **Flag de prueba**: simula el paso "abrir juego" sin lanzar el exe real (para probar el polling de vinculación contra la API). |
| `link_poll_interval`    | Segundos entre consultas de candidatos (default 10).          |
| `link_poll_max_seconds` | Tiempo máximo de espera de conexión (default 180 = 3 min).    |

## Datos por usuario

- Token JWT: `%APPDATA%\iw4x-ranking-launcher\token.json` (auto-login).
- Log rotativo: `%APPDATA%\iw4x-ranking-launcher\logs\launcher.log`.

## Flujo JUGAR

1. Si `/auth/me` indica cuenta sin `linkedGuid` → `POST /api/link/start`.
2. Lanza `iw4x.exe +set name <displayName> +connect <server>` (subprocess con
   lista de args, cwd = carpeta del juego). El `+set name` solo se añade si
   `force_nick` está activo y la cuenta tiene displayName: los engines Q3
   procesan `+set` tras cargar configs, así el nick del ranking gana al nick
   guardado en el config del juego, sin tocar archivos.
3. `POST /api/link/complete` (poll): 1 candidato → confirmación automática;
   varios → diálogo para elegir el tuyo; ninguno → espera y reintento hasta
   3 min. Un `409 USER_ALREADY_LINKED` se trata como éxito.
4. Al vincular: mensaje "Cuenta vinculada ✓" y refresco de `/auth/me`.

## Prueba de humo

`test_smoke.py` verifica en vivo contra la API real (registro, login,
auto-login, flujo JUGAR simulado, rutas 409 y diálogo multi-candidato):

```bat
py apps\launcher\test_smoke.py
```
