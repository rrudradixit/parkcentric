# Government Polytechnic Panchkula Unified API Reference 🚗💨

The ParkCentri API provides two ways to interact with the parking hardware:
1. **WebSocket (Real-time)**: For live dashboard updates.
2. **REST API (Request/Response)**: For polling, manual control, or external integrations.

---

## 1. REST API (Port 8080)

### 🟢 GET /status
Returns the current occupancy status of all monitored slots.
- **Example URL**: `http://localhost:8080/status`
- **Response**:
```json
{
  "A1": "OCCUPIED"
}
```

### 🟡 GET /status/{slot_id}
Check the status of a specific slot.
- **Example URL**: `http://localhost:8080/status/A1`
- **Response**:
```json
{
  "slot": "A1",
  "status": "EMPTY"
}
```

### 🔴 POST /manual-update
Manually force a slot into a specific state. Great for testing without a physical sensor!
- **URL**: `http://localhost:8080/manual-update`
- **Body (JSON)**:
```json
{
  "slot": "A1",
  "status": "OCCUPIED" 
}
```
*(Status must be "OCCUPIED" or "EMPTY")*

---

## 2. WebSocket (Real-time)

- **URL**: `ws://localhost:8080/`
- **Events Transmitted**:
```json
{
  "type": "SENSOR_UPDATE",
  "slot": "A1",
  "status": "OCCUPIED"
}
```
---

## Technical Setup
- **Language**: Python (FastAPI)
- **Port**: 8080
- **Baud Rate**: 9600
- **COM Port**: COM3 (Configurable in `backend.py`)
