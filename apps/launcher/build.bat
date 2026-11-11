@echo off
REM ============================================================
REM  Build del launcher IW4x Ranking (Windows)
REM  Genera UN solo ejecutable: dist\IW4xLauncher.exe
REM  Uso: build.bat
REM ============================================================
setlocal
cd /d "%~dp0"

REM Asegura PyInstaller (no modifica nada del proyecto).
py -m pip show pyinstaller >nul 2>&1
if errorlevel 1 (
    echo Instalando PyInstaller...
    py -m pip install pyinstaller
    if errorlevel 1 goto :error
)

echo Compilando...
REM --uac-admin: el EXE lleva manifest requireAdministrator — UN solo UAC al
REM abrir el launcher y TODO lo que lance (iw4x.exe) hereda administrador.
REM Sin elevation el juego NO conecta (queda en el menú): la prueba controlada
REM del dueño lo confirmó — su acceso directo elevado funciona SIEMPRE.
py -m PyInstaller --noconfirm --onefile --windowed --uac-admin --clean --name IW4xLauncher --icon "assets\logo-icon.ico" --add-data "assets\logo-icon.ico;assets" --add-data "assets\logo-icon.png;assets" --add-data "assets\logo-banner.png;assets" --add-data "assets\medals;assets\medals" main.py
if errorlevel 1 goto :error

echo.
echo OK: ejecutable generado en dist\IW4xLauncher.exe
echo (launcher.config.json se crea junto al .exe al primera arranque)
exit /b 0

:error
echo.
echo ERROR: el build fallo. Revisa la salida de arriba.
exit /b 1
