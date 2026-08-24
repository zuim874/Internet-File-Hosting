@echo off
REM ============================================================
REM  Wenpu - Intranet File Host  launcher
REM  Double-click to start. Config read from .env (see server.js).
REM  This script ALWAYS pauses at the end so the window stays open,
REM  no matter whether the service starts or exits.
REM ============================================================
setlocal EnableExtensions
title Wenpu - File Host
cd /d "%~dp0"

REM ---------- defaults ----------
set "PORT=8080"
set "FILE_ROOT=%USERPROFILE%\FileHost"

REM ---------- override with .env if present ----------
if exist ".env" call :loadenv
REM ------------------------------------------------

echo.
echo  ============================================================
echo   Wenpu Intranet File Host
echo   ----------------------------------------------------------
echo   Port       : %PORT%
echo   Root dir   : %FILE_ROOT%
echo   URL        : http://localhost:%PORT%
echo   ----------------------------------------------------------
echo   Window stays open while the service is running.
echo   Stop it: press Ctrl+C or just close the window.
echo  ============================================================
echo.

REM check node
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [ERROR] Node.js not found. Install it from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM run node in foreground; always pause afterwards
node server.js
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
    echo  [STATUS] Service stopped normally.
) else (
    echo  [STATUS] Service exited with code %EXITCODE%. Check log above.
)
echo  (The window will not close by itself; close it manually.)
echo.
pause
endlocal
exit /b 0

REM ============================================================
:loadenv
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT"      set "PORT=%%b"
    if /i "%%a"=="FILE_ROOT" set "FILE_ROOT=%%b"
)
exit /b 0