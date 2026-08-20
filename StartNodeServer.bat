@echo off
echo ==============================================
echo ParkCentri - Arduino Hardware Bridge Setup
echo (Powered by Node.js REST API)
echo ==============================================
echo.
echo Installing required Node.js dependencies...
call npm install express serialport @serialport/parser-readline cors
echo.
echo Starting the Hardware Data API...
echo ----------------------------------------------
echo IMPORTANT: Ensure your Arduino IDE Serial Monitor is CLOSED!
echo ----------------------------------------------
node server.js
pause
