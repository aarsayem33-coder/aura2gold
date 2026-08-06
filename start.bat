@echo off
title Aura Gold Alerts Dev Server
echo ===================================================
echo   Starting Aura Gold Alerts...
echo   Frontend: http://localhost:5173 (Network: http://192.168.0.173:5173)
echo   Backend:  http://127.0.0.1:5000
echo   Database: local MySQL 8.4 (127.0.0.1:3306)
echo ===================================================

:: ---------------------------------------------------------------------------
:: The database now runs on this machine, so nothing works until the MySQL
:: service is up. It is set to Automatic and normally starts at boot; this is
:: the safety net for when it has been stopped manually or failed to start.
:: Without it the backend boots "fine" and then fails every single query.
:: ---------------------------------------------------------------------------
sc query MySQL84 | find "RUNNING" >nul 2>&1
if %errorlevel%==0 (
    echo [DB] MySQL84 service is running.
) else (
    echo [DB] MySQL84 is not running - starting it...
    net start MySQL84 >nul 2>&1
    if errorlevel 1 (
        echo [DB] Needs administrator rights - prompting...
        powershell -NoProfile -Command "Start-Process net -ArgumentList 'start','MySQL84' -Verb RunAs -Wait" >nul 2>&1
    )
    :: Confirm it actually came up rather than assuming the command worked.
    timeout /t 3 /nobreak >nul
    sc query MySQL84 | find "RUNNING" >nul 2>&1
    if errorlevel 1 (
        echo.
        echo [DB] ERROR: MySQL84 could not be started.
        echo      The app will load but every database page will fail.
        echo      Try manually from an admin prompt:  net start MySQL84
        echo.
        pause
    ) else (
        echo [DB] MySQL84 started.
    )
)

:: Instantly open browser to the frontend dashboard
start "" "http://localhost:5173"

:: Start the concurrently dev servers
npm run dev
