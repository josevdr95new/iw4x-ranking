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
| `cloud_save`            | **true** por defecto: sincroniza el progreso (`players\iw4x.stat`, `iw4x_config.cfg`, `mods\<mod>\iw4x.stat`) con la cuenta antes de abrir el juego y al cerrarlo (backup automático previo en `%APPDATA%\iw4x-ranking-launcher\save-backups\`). Editable en Ajustes. |
| `simulate_game`         | **Flag de prueba**: simula el paso "abrir juego" sin lanzar el exe real (para probar el polling de vinculación contra la API). |
| `link_poll_interval`    | Segundos entre consultas de candidatos (default 10).          |
| `link_poll_max_seconds` | Tiempo máximo de espera de conexión (default 180 = 3 min).    |

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

## Prueba de humo

`test_smoke.py` verifica en vivo contra la API real (registro, login,
auto-login, flujo JUGAR simulado, rutas 409 y diálogo multi-candidato):

```bat
py apps\launcher\test_smoke.py
```
