@echo off
REM Wanji one-click joiner: runs after the joiner EXE extracts itself.
REM Expects in this folder: node.exe, app\ (bin/src/desktop/web/package.json), join.json.
REM Installs the app + node to a permanent home, joins the main computer, sets up
REM autostart and starts the service. No input needed; just run the joiner EXE.
setlocal EnableDelayedExpansion
set "STAGE=%~dp0"
set "HOME_DIR=%APPDATA%\computer-mcp"
if not exist "%HOME_DIR%\app" mkdir "%HOME_DIR%\app"
if not exist "%HOME_DIR%\runtime" mkdir "%HOME_DIR%\runtime"
echo [1/4] Installing Wanji files...
xcopy /E /Y /Q "%STAGE%app" "%HOME_DIR%\app\" >nul
if errorlevel 1 goto :fail
copy /Y "%STAGE%node.exe" "%HOME_DIR%\runtime\node.exe" >nul
if errorlevel 1 goto :fail
set "NODE=%HOME_DIR%\runtime\node.exe"
set "CLI=%HOME_DIR%\app\bin\wanji.mjs"
echo [2/4] Connecting to the main computer...
"%NODE%" "%CLI%" join --file "%STAGE%join.json"
if errorlevel 1 goto :fail
echo [3/4] Setting up automatic start...
"%NODE%" "%CLI%" autostart
if errorlevel 1 goto :fail
echo [4/4] Done. This computer is now connected to the main computer.
echo It will reconnect automatically every time you log on.
pause
exit /b 0
:fail
echo.
echo Something went wrong. Please take a screenshot of this window and send it to the person who gave you this program.
pause
exit /b 1
