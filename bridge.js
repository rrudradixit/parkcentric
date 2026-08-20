const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const WebSocket = require('ws');

// ==========================================
// 1. CONFIGURATION
// ==========================================
// Change this to match your Arduino's COM port (e.g., 'COM3' on Windows, '/dev/ttyUSB0' on Linux/Mac)
const ARDUINO_PORT = 'COM3';
const BAUD_RATE = 9600;
const WEBSOCKET_PORT = 8080;

// ==========================================
// 2. SETUP WEBSOCKET SERVER
// ==========================================
const wss = new WebSocket.Server({ port: WEBSOCKET_PORT });
console.log(`WebSocket server started on ws://localhost:${WEBSOCKET_PORT}`);

// Array to keep track of connected web clients (the dashboard)
let connectedClients = [];

wss.on('connection', (ws) => {
    console.log('[WS] Dashboard Client Connected!');
    connectedClients.push(ws);

    // Send the current known state immediately upon connection
    ws.send(JSON.stringify({ type: 'STATUS', message: 'Connected to Arduino Bridge' }));

    ws.on('close', () => {
        console.log('[WS] Dashboard Client Disconnected');
        connectedClients = connectedClients.filter(client => client !== ws);
    });
});

// Function to broadcast sensor data to all open dashboards
function broadcastToDashboards(data) {
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}


// ==========================================
// 3. SETUP ARDUINO SERIAL CONNECTION
// ==========================================
const port = new SerialPort({
    path: ARDUINO_PORT,
    baudRate: BAUD_RATE,
    autoOpen: false
});

const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

port.open((err) => {
    if (err) {
        console.error(`\n[ERROR] Could not open Serial Port ${ARDUINO_PORT}.`);
        console.error(`Make sure the Arduino is plugged in, the port is correct, and the Arduino IDE Serial Monitor is CLOSED.\n`);
        return;
    }
    console.log(`[SERIAL] Successfully connected to Arduino on ${ARDUINO_PORT} at ${BAUD_RATE} baud.`);
});

// Listen for actual data coming from the Arduino
parser.on('data', (data) => {
    const reading = data.trim();
    console.log(`[ARDUINO SENSOR]: ${reading}`);

    // Broadcast the raw reading over WebSockets
    broadcastToDashboards({
        type: 'SENSOR_UPDATE',
        slot: 'A1',
        status: reading // "OCCUPIED" or "EMPTY"
    });
});

port.on('close', () => {
    console.log('[SERIAL] Arduino disconnected.');
});
