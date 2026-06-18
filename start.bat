@echo off
title Aura Gold Alerts Dev Server
echo ===================================================
echo   Starting Aura Gold Alerts...
echo   Frontend: http://localhost:5173 (Network: http://192.168.0.173:5173)
echo   Backend:  http://127.0.0.1:5000
echo ===================================================

:: Instantly open browser to the frontend dashboard
start "" "http://localhost:5173"

:: Start the concurrently dev servers
npm run dev
