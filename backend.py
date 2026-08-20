import asyncio
import json
import logging
import serial
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# Configuration
ARDUINO_PORT = 'COM3'  # Make sure this matches your Arduino IDE Port
BAUD_RATE = 9600
API_PORT = 8080

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="TRINETRA Unified API")

# Allow CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Global State ---
parking_status = {
    "1-1": "EMPTY"
}
serial_connected = False

class StatusUpdate(BaseModel):
    slot: str
    status: str  # "OCCUPIED" or "EMPTY"

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logging.info("[WS] Dashboard Client Connected!")
        # Send current global state and serial status on connection
        await websocket.send_text(json.dumps({
            "type": "INIT_STATUS", 
            "data": parking_status,
            "serial_ready": serial_connected
        }))

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logging.info("[WS] Dashboard Client Disconnected")

    async def broadcast(self, message: dict):
        for connection in list(self.active_connections):
            try:
                await connection.send_text(json.dumps(message))
            except Exception as e:
                logging.error(f"Error sending to client: {e}")
                self.disconnect(connection)

manager = ConnectionManager()

# --- Background Task: Serial Reader ---
async def read_from_serial():
    global parking_status, serial_connected
    print(f"\n[SYS] Searching for Arduino on {ARDUINO_PORT}...")
    
    while True:
        try:
            ser = serial.Serial(ARDUINO_PORT, BAUD_RATE, timeout=0.1)
            print(f"[SERIAL] SUCCESS: Connected to {ARDUINO_PORT} at {BAUD_RATE} baud.")
            serial_connected = True
            await manager.broadcast({"type": "SERIAL_STATUS", "connected": True})
            
            while True:
                if ser.in_waiting > 0:
                    raw_line = ser.readline()
                    line = raw_line.decode('utf-8', errors='ignore').strip().lower()
                    
                    if line:
                        print(f" >>> [ARDUINO DATA]: '{line}'")
                        
                        new_status = None
                        if "occupied" in line:
                            new_status = "OCCUPIED"
                        elif "vacant" in line or "empty" in line:
                            new_status = "EMPTY"
                            
                        if new_status:
                            print(f" [COMMAND] Mapping detected: {new_status}")
                            if parking_status.get("1-1") != new_status:
                                parking_status["1-1"] = new_status
                                payload = {
                                    "type": "SENSOR_UPDATE",
                                    "slot": "1-1",
                                    "status": new_status
                                }
                                await manager.broadcast(payload)
                                print(f" [WS] Broadcasted {new_status} to Dashboard.")
                
                await asyncio.sleep(0.01)
                
        except (serial.SerialException, Exception) as e:
            if serial_connected:
                print(f"\n[!!!] SERIAL DISCONNECTED: {e}")
                serial_connected = False
                await manager.broadcast({"type": "SERIAL_STATUS", "connected": False})
            
            # Retry every 5 seconds if not connected
            await asyncio.sleep(5)

async def send_heartbeat():
    """Sends a periodic heartbeat with current serial status."""
    while True:
        await manager.broadcast({
            "type": "HEARTBEAT", 
            "status": "ALIVE",
            "serial_ready": serial_connected
        })
        await asyncio.sleep(10)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(read_from_serial())
    asyncio.create_task(send_heartbeat())

# --- REST API Endpoints ---

@app.get("/status")
async def get_all_status():
    """Returns the current occupancy status of all hardware slots."""
    return parking_status

@app.get("/status/{slot_id}")
async def get_slot_status(slot_id: str):
    """Returns the status of a specific slot (e.g., A1)."""
    status = parking_status.get(slot_id.upper())
    if not status:
        raise HTTPException(status_code=404, detail="Slot not found")
    return {"slot": slot_id.upper(), "status": status}

@app.post("/manual-update")
async def manual_update(update: StatusUpdate):
    """Allows manual override of a slot's status via REST API."""
    slot = update.slot.upper()
    status = update.status.upper()
    
    if status not in ["OCCUPIED", "EMPTY"]:
        raise HTTPException(status_code=400, detail="Invalid status. Use OCCUPIED or EMPTY.")

    parking_status[slot] = status
    
    # Broadcast manual update to dashboard
    payload = {
        "type": "SENSOR_UPDATE",
        "slot": slot,
        "status": status
    }
    await manager.broadcast(payload)
    
    return {"message": f"Slot {slot} updated to {status}", "current_state": parking_status}

# --- WebSocket Endpoint ---

@app.websocket("/")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep socket alive and listen for any client messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

if __name__ == "__main__":
    print(f"\n==============================================")
    print(f" TRINETRA Unified API: Starting Server...   ")
    print(f" REST API: http://localhost:{API_PORT}/status ")
    print(f" WebSocket: ws://localhost:{API_PORT}/        ")
    print(f"==============================================\n")
    uvicorn.run("backend:app", host="0.0.0.0", port=API_PORT, log_level="info")
