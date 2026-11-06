@echo off
REM Wanji one-click joiner: runs after the joiner EXE extracts itself.
REM Expects in this folder: node.exe, app\ (bin/src/desktop/web/package.json), join.json.
REM Everything runs from this extracted copy: `join` first checks this computer and
REM the one-use code, and only then stops any old service, copies node and the app
REM into the Wanji folder, sets up autostart (one administrator prompt) and starts it.
REM All messages come from node, which prints Chinese correctly; this file stays ASCII.
setlocal
cd /d "%~dp0"
"%~dp0node.exe" "%~dp0app\bin\wanji.mjs" join --file "%~dp0join.json" --install-runtime --joiner
set "RC=%errorlevel%"
echo.
pause
exit /b %RC%
