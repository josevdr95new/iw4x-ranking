@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================
rem  IW4x Ranking - arranque completo del sistema en Windows
rem  Idempotente: si un servicio ya esta arriba, NO lo duplica.
rem  No instala nada automaticamente (pide npm install si falta).
rem  Server del juego arranca ANTES que IW4MAdmin (su RCon
rem  apunta a 127.0.0.1:28961 y sin server crashea).
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================================
echo    IW4x Ranking — levantando sistema…
echo ============================================================
echo.

rem --- curl requerido para los health-checks ---
where curl >nul 2>&1
if errorlevel 1 (
  echo [ERROR] curl no esta disponible en el PATH. Se necesita Windows 10+.
  exit /b 1
)

rem ---------- 0. Prerequisitos ----------
if not exist "apps\api\node_modules" (
  echo [ERROR] Falta apps\api\node_modules
  echo         Ejecuta primero:   npm install
  echo         ^(no se instala automaticamente a proposito^)
  exit /b 1
)
if not exist "apps\api\.env" (
  if exist ".env.example" (
    copy /y ".env.example" "apps\api\.env" >nul
    echo [INFO] apps\api\.env no existia: creado desde .env.example.
    echo        Revisa/ajusta sus valores antes de pasar a producción.
  ) else (
    echo [WARN] No hay apps\api\.env ni .env.example: la API puede fallar al arrancar.
  )
)

rem ---------- 1. API :3000 ----------
echo [1/5] API ^(puerto 3000^)...
call :http_code "http://localhost:3000/api/health"
if "%HTTP_CODE%"=="200" goto api_ok
call :port_busy 3000
if "%PORT_LIVE%"=="1" (
  echo [WARN] Puerto 3000 ocupado pero /api/health no responde.
  echo        No se lanza otra instancia para no duplicar. Revisa ese proceso.
  goto web_step
)
echo [API]  No responde. Iniciando en ventana "iw4x-api"...
start "iw4x-api" cmd /k "npm run dev:api"
call :wait_http "http://localhost:3000/api/health" 30
if "%RESULT%"=="1" goto api_ok
echo [ERROR] La API no respondio en ~30s. La ventana "iw4x-api" queda abierta
echo         con el detalle del fallo. Los demas servicios continuan.
goto web_step

:api_ok
echo [API]  Ya arriba ✓  health 200 en http://localhost:3000/api/health

rem ---------- 2. Web :5173 ----------
:web_step
echo.
echo [2/5] Web ^(puerto 5173^)...
call :web_up
if "%WEB_UP%"=="1" goto web_ok
if "%WEB_UP%"=="2" (
  echo [WARN] Puerto 5173 ocupado pero no responde HTTP todavia.
  echo        No se lanza otra instancia para no duplicar.
  goto srv_step
)
if not exist "apps\web\node_modules" (
  echo [WARN] Falta apps\web\node_modules: no se puede iniciar la web.
  echo        Ejecuta npm install y vuelve a intentar.
  goto srv_step
)
echo [WEB]  No responde. Iniciando en ventana "iw4x-web"...
start "iw4x-web" cmd /k "npm run dev -w apps/web"
call :wait_web 25
if "%RESULT%"=="1" goto web_ok
echo [ERROR] La web no respondio en ~25s. Ventana "iw4x-web" abierta con el detalle.
goto srv_step

:web_ok
echo [WEB]  Ya arriba ✓  http://localhost:5173

rem ---------- 3. Server dedicado del juego :28961 ----------
rem  IMPORTANTE: con /D el CWD de la ventana es la carpeta del juego,
rem  porque DedicatedServer.bat hace "start iw4x.exe" con ruta relativa.
:srv_step
echo.
echo [3/5] Server dedicado del juego ^(28961^)...
if not exist "D:\Call of Duty 6\DedicatedServer.bat" (
  echo [SRV]  Omitido: no instalado en esta PC ^(falta D:\Call of Duty 6\DedicatedServer.bat^).
  goto mod_step
)
call :port_busy 28961
if "%PORT_LIVE%"=="1" goto srv_ok
echo [SRV]  Iniciando en ventana "iw4x-server" ^(CWD: D:\Call of Duty 6^)...
start "iw4x-server" /D "D:\Call of Duty 6" cmd /k "DedicatedServer.bat"
call :wait_port 28961 45
if "%RESULT%"=="1" goto srv_ok
echo [WARN] Server lanzado pero 28961 aun no escucha ^(puede tardar mas^).
echo        Revisa la ventana "iw4x-server".
goto mod_step

:srv_ok
echo [SRV]  Ya arriba ✓  puerto 28961 en uso

rem ---------- 4. Moderacion IW4MAdmin :1624 ----------
rem  IMPORTANTE: con /D el CWD es D:\IW4MAdmin (config/logs relativos).
rem  Se lanza DESPUES del server: su RCon apunta a 127.0.0.1:28961.
:mod_step
echo.
echo [4/5] Moderacion IW4MAdmin ^(puerto 1624^)...
if not exist "D:\IW4MAdmin\Lib\IW4MAdmin.dll" (
  echo [MOD]  Omitido: no instalado en esta PC ^(falta D:\IW4MAdmin\Lib\IW4MAdmin.dll^).
  goto launcher_step
)
call :port_busy 1624
if "%PORT_LIVE%"=="1" goto mod_ok
echo [MOD]  Iniciando en ventana "iw4x-moderacion" ^(CWD: D:\IW4MAdmin^)...
start "iw4x-moderacion" /D "D:\IW4MAdmin" cmd /k "dotnet Lib\IW4MAdmin.dll --no-confirm"
call :wait_port 1624 60
if "%RESULT%"=="1" goto mod_ok
echo [WARN] Moderacion lanzada pero el puerto 1624 aun no responde.
echo        Puede seguir calentando o haber fallado ^(mira la ventana "iw4x-moderacion"^).
goto launcher_step

:mod_ok
echo [MOD]  Ya arriba ✓  http://localhost:1624

rem ---------- 5. Launcher ----------
:launcher_step
echo.
echo [5/5] Launcher: no se arranca desde aqui ^(el dueño usa su exe^).
echo        Hint: dist\IW4xLauncher.exe   o   py apps\launcher\main.py

rem ---------- Resumen ----------
:summary
echo.
echo ============================================================
echo    RESUMEN
echo ============================================================
call :http_code "http://localhost:3000/api/health"
if "%HTTP_CODE%"=="200" (echo    API          http://localhost:3000   ✓) else (echo    API          http://localhost:3000   ✗ CAIDA)
call :web_up
if "%WEB_UP%"=="1" (echo    Web          http://localhost:5173   ✓) else (if "%WEB_UP%"=="2" (echo    Web          http://localhost:5173   - puerto ocupado, sin HTTP) else (echo    Web          http://localhost:5173   ✗ CAIDA))
call :port_busy 28961
if "%PORT_LIVE%"=="1" (echo    Server       192.168.3.99:28961 ^(o el de la config^) ✓) else (echo    Server       28961   - no instalado o caido)
call :port_busy 1624
if "%PORT_LIVE%"=="1" (echo    Moderacion   http://localhost:1624   ✓) else (echo    Moderacion   http://localhost:1624   - no instalada o caida)
echo.
echo    Login admin por defecto ^(solo si la DB acaba de sembrarse^):
echo      nick: admin     pass: admin123     ^(CAMBIALA tras el primer login^)
echo.
echo    Ventanas: iw4x-api / iw4x-web / iw4x-server / iw4x-moderacion
echo    Para detener todo:  stop-all.bat
echo.
exit /b 0

rem ================== subrutinas ==================

:http_code   [%1=URL] -> HTTP_CODE (200/000/...)
set "HTTP_CODE=000"
for /f "delims=" %%i in ('curl -s -o nul -w "%%{http_code}" --max-time 2 "%~1" 2^>nul') do set "HTTP_CODE=%%i"
exit /b 0

:port_busy   [%1=puerto] -> PORT_LIVE (0/1)
set "PORT_LIVE=0"
netstat -ano 2>nul | findstr ":%~1 " >nul
if not errorlevel 1 set "PORT_LIVE=1"
exit /b 0

:web_up      -> WEB_UP (1=http ok en IPv4 o IPv6, 2=puerto ocupado sin http, 0=libre)
set "WEB_UP=0"
call :http_code "http://localhost:5173"
if "%HTTP_CODE%"=="200" set "WEB_UP=1"
if "%WEB_UP%"=="1" exit /b 0
call :http_code "http://[::1]:5173"
if "%HTTP_CODE%"=="200" set "WEB_UP=1"
if "%WEB_UP%"=="1" exit /b 0
call :port_busy 5173
if "%PORT_LIVE%"=="1" set "WEB_UP=2"
exit /b 0

:wait_http   [%1=URL %2=max intentos] -> RESULT (1/0)
set /a WTRIES=0
:wait_http_loop
call :http_code "%~1"
if "%HTTP_CODE%"=="200" goto wait_http_hit
set /a WTRIES+=1
if %WTRIES% GEQ %~2 goto wait_http_miss
ping -n 2 127.0.0.1 >nul
goto wait_http_loop
:wait_http_hit
set "RESULT=1"
exit /b 0
:wait_http_miss
set "RESULT=0"
exit /b 0

:wait_web    [%1=max intentos] -> RESULT (1/0)  usa :web_up
set /a WTRIES=0
:wait_web_loop
call :web_up
if "%WEB_UP%"=="1" goto wait_web_hit
set /a WTRIES+=1
if %WTRIES% GEQ %~1 goto wait_web_miss
ping -n 2 127.0.0.1 >nul
goto wait_web_loop
:wait_web_hit
set "RESULT=1"
exit /b 0
:wait_web_miss
set "RESULT=0"
exit /b 0

:wait_port   [%1=puerto %2=max intentos] -> RESULT (1/0)
set /a WTRIES=0
:wait_port_loop
call :port_busy %~1
if "%PORT_LIVE%"=="1" goto wait_port_hit
set /a WTRIES+=1
if %WTRIES% GEQ %~2 goto wait_port_miss
ping -n 2 127.0.0.1 >nul
goto wait_port_loop
:wait_port_hit
set "RESULT=1"
exit /b 0
:wait_port_miss
set "RESULT=0"
exit /b 0
