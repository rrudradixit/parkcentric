@echo off
echo ==============================================
echo   ParkCentri - FastAPI (Python) Bridge
echo ==============================================
echo.

:: 1. Force kill any existing Python/Uvicorn or Node processes that might be holding COM3 or Port 8080/3000
echo [1/4] Cleaning up existing server processes...
taskkill /F /IM python.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: 2. Ensure dependencies are installed
echo [2/4] Verifying Python dependencies...
pip install fastapi uvicorn pyserial websockets >nul 2>&1

:: 3. Start the FastAPI backend in a new window
echo [3/4] Starting FastAPI Bridge (backend.py on port 8080)...
start "ParkCentri FastAPI Backend" cmd /k "python backend.py"

:: 4. Wait for server to start then open the dashboard
timeout /t 3 /nobreak >nul
echo [4/4] Opening Dashboard...
start "" "index.html"

echo.
echo ==============================================
echo   SYSTEM READY! 
echo   1. Keep the "ParkCentri FastAPI Backend" window open.
echo   2. Ensure Arduino is plugged into COM3.
echo   3. Close Arduino IDE Serial Monitor.
echo ==============================================
echo.
pause
