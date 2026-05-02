@echo off
REM ============================================================
REM   GeoAI — Cloudflare Tunnel launcher
REM ============================================================
REM   Spins up:
REM     1. Local Node dev server  (serves static + /api/assessments)
REM     2. cloudflared quick tunnel  (free, no account, ephemeral)
REM
REM   The public URL prints in THIS window after a few seconds.
REM   Looks like:  https://random-words.trycloudflare.com
REM
REM   Stop everything with Ctrl+C, then close the spawned server
REM   window if it stays open.
REM ============================================================

setlocal
set PORT=8000

REM Locate cloudflared: prefer bundled tools\cloudflared.exe,
REM fall back to whatever's on PATH.
set CLOUDFLARED=%~dp0tools\cloudflared.exe
if not exist "%CLOUDFLARED%" (
  where cloudflared >nul 2>&1
  if errorlevel 1 (
    echo ERROR: cloudflared not found.
    echo.
    echo Either install via winget:
    echo   winget install Cloudflare.cloudflared
    echo.
    echo OR drop the standalone exe into the tools\ folder:
    echo   https://github.com/cloudflare/cloudflared/releases/latest
    echo   ^(rename cloudflared-windows-amd64.exe to cloudflared.exe^)
    echo.
    pause
    exit /b 1
  )
  set CLOUDFLARED=cloudflared
)

echo.
echo === GeoAI Cloudflare Tunnel ===
echo.
echo Starting local server on http://localhost:%PORT% ...
start "GeoAI dev server" cmd /k "cd /d %~dp0 && node server.js"

REM Give Node a moment to bind the port.
ping 127.0.0.1 -n 4 > nul

echo.
echo Starting cloudflared quick tunnel...
echo Public URL will appear below in 5-10 seconds.
echo.
echo ============================================================
"%CLOUDFLARED%" tunnel --url http://localhost:%PORT% --no-autoupdate
