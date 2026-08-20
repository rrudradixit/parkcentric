// ============================================================
//  TRINETRA - Node.js REST API Server
//  Reads Arduino serial data → exposes GET /parking-status
//  Frontend polls this endpoint every second for live updates.
// ============================================================

const express  = require('express');
const { SerialPort }     = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const cors     = require('cors');

const app       = express();
const PORT      = 3000;
const BAUD_RATE = 9600;

app.use(cors());

// Serve login.html as the entry point (root /)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/login.html');
});

// Serve all other static files (index.html, script.js, style.css, etc.)
app.use(express.static(__dirname));


// ── Parking State ──────────────────────────────────────────
// slotA1 is driven by the single Arduino sensor on trig=9 / echo=10
let parkingStatus = {
    slotA1: 'vacant'
};
let serialLog = [];     // stores last 20 raw lines from Arduino
let reportRecords = []; // persistent parking records for the report page
let activeSessions = {
    slotA1: null // stores { in: Date, vehicle: string }
};

// Utility to generate a plate number (similar to script.js)
function generatePlate() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const L1 = letters[Math.floor(Math.random() * 26)] + letters[Math.floor(Math.random() * 26)];
    const N1 = Math.floor(Math.random() * 90) + 10;
    const L2 = letters[Math.floor(Math.random() * 26)] + letters[Math.floor(Math.random() * 26)];
    const N2 = Math.floor(Math.random() * 9000) + 1000;
    return `${L1}-${N1}-${L2}-${N2}`;
}

// Function to handle state change and record sessions
function handleStatusChange(slot, newStatus) {
    if (newStatus === 'occupied') {
        if (!activeSessions[slot]) {
            activeSessions[slot] = { in: new Date(), vehicle: generatePlate() };
            console.log(`[SESSION] Started for ${slot} | Vehicle: ${activeSessions[slot].vehicle}`);
        }
    } else if (newStatus === 'vacant') {
        if (activeSessions[slot]) {
            const session = activeSessions[slot];
            const outTime = new Date();
            const duration = Math.ceil((outTime - session.in) / 60000); // duration in minutes
            
            const record = {
                slot: 'A1', // Hardcoded for now as per system design
                zone: 'Zone A',
                in: session.in,
                out: outTime,
                vehicle: session.vehicle,
                duration: duration,
                price: (duration * 1.1).toFixed(2) // Updated to 1.1 Rs per minute
            };
            
            reportRecords.unshift(record);
            activeSessions[slot] = null;
            console.log(`[REPORT] Recorded session for ${session.vehicle} | Duration: ${duration} min`);
        }
    }
}


// ── Auto-detect Arduino Port ──────────────────────────────
async function findArduinoPort() {
    try {
        const ports = await SerialPort.list();
        console.log('[SYS] Available serial ports:');
        ports.forEach(p => console.log(`       ${p.path} — ${p.manufacturer || 'unknown'}`));

        // Prefer a port with "Arduino" in the manufacturer string
        let found = ports.find(p =>
            p.manufacturer && p.manufacturer.toLowerCase().includes('arduino')
        );

        // Fallback: first USB-serial device (matches COMx on Windows, /dev/tty.usbmodem on Mac)
        if (!found) {
            found = ports.find(p =>
                (p.vendorId && p.productId) ||
                p.path.toLowerCase().includes('com')
            );
        }

        if (found) {
            console.log(`[SYS] ✔ Arduino detected on: ${found.path}`);
            return found.path;
        }

        console.warn('[SYS] ⚠ Could not auto-detect Arduino. Falling back to COM3.');
        return 'COM3';
    } catch (err) {
        console.error('[SYS] Error listing ports:', err.message);
        return 'COM3';
    }
}

// ── Open Serial & Listen ──────────────────────────────────
async function initSerial() {
    const portPath = await findArduinoPort();
    console.log(`[SERIAL] Connecting to ${portPath} @ ${BAUD_RATE} baud...`);

    const port = new SerialPort({ path: portPath, baudRate: BAUD_RATE, autoOpen: false });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    port.open(err => {
        if (err) {
            console.error(`[ERROR] Cannot open ${portPath} — ${err.message}`);
            console.error('        ⚠  CLOSE the Arduino IDE Serial Monitor, then wait...');
            // Retry in 3 seconds
            setTimeout(initSerial, 3000);
            return;
        }
        console.log(`[SERIAL] ✔ Connected to Arduino on ${portPath}\n`);
    });

    // Parse lines from Arduino
    // Handles: "Occupied" / "Vacant"  or  "Distance: 12.5 cm -> Occupied"
    parser.on('data', line => {
        const raw = line.trim();
        console.log(`[SERIAL RAW] ${raw}`);
        serialLog.push(`${new Date().toLocaleTimeString()} | ${raw}`);
        if (serialLog.length > 20) serialLog.shift();

        const lower = raw.toLowerCase();
        let newStatus = null;

        if (lower.includes('occupied'))   newStatus = 'occupied';
        else if (lower.includes('vacant') || lower.includes('empty')) newStatus = 'vacant';

        if (newStatus && parkingStatus.slotA1 !== newStatus) {
            handleStatusChange('slotA1', newStatus);
            parkingStatus.slotA1 = newStatus;
            console.log(`[SENSOR] Slot A1 → ${newStatus.toUpperCase()}`);
        }
    });

    // Auto-reconnect when port closes (Arduino unplugged or Serial Monitor closed)
    port.on('close', () => {
        console.log('[SERIAL] Port closed. Auto-reconnecting in 3 seconds...');
        setTimeout(initSerial, 3000);
    });

    port.on('error', err => {
        console.error('[SERIAL] Port error:', err.message);
    });
}


// ── REST Endpoints ────────────────────────────────────────

// GET /parking-status  →  { "slotA1": "occupied" | "vacant", "session": { ... } }
app.get('/parking-status', (req, res) => {
    res.json({
        ...parkingStatus,
        activeSession: activeSessions.slotA1
    });
});

// GET /serial-log  →  last 20 raw lines from Arduino
app.get('/serial-log', (req, res) => {
    res.json({ recentLines: serialLog });
});

// GET /report-data  →  full history for JS export
app.get('/report-data', (req, res) => {
    res.json(reportRecords);
});

app.get('/debug', (req, res) => {
    res.json({ parkingStatus, uptime: process.uptime().toFixed(1) + 's', time: new Date().toISOString() });
});

// Manual overrides for UI testing (no Arduino needed)
app.get('/test-occupied', (req, res) => {
    handleStatusChange('slotA1', 'occupied');
    parkingStatus.slotA1 = 'occupied';
    console.log('[TEST] Manually set slotA1 → occupied');
    res.json({ ok: true, parkingStatus });
});
app.get('/test-vacant', (req, res) => {
    handleStatusChange('slotA1', 'vacant');
    parkingStatus.slotA1 = 'vacant';
    console.log('[TEST] Manually set slotA1 → vacant');
    res.json({ ok: true, parkingStatus });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime().toFixed(1) + 's' });
});

// ── Generate parking records ONCE at startup (persistent) ──
(function generateRecords() {
    const slots   = Array.from({length: 20}, (_, i) => `S${i + 1}`);
    const zones   = ['Zone A', 'Zone B', 'Zone C', 'Zone D'];
    const states  = ['HR', 'DL', 'PB', 'UP', 'CH'];
    const alpha   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    const ri  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
    const rc  = arr  => arr[Math.floor(Math.random() * arr.length)];
    const rl  = n    => Array.from({length:n}, () => alpha[ri(0,25)]).join('');
    const veh = ()   => `${rc(states)} ${ri(10,99)} ${rl(2)} ${ri(1000,9999)}`;

    const total = ri(70, 80);
    for (let i = 0; i < total; i++) {
        const inTime   = new Date(Date.now() - ri(0,2)*86400000 - ri(0,23)*3600000 - ri(0,59)*60000);
        const duration = ri(15, 240);
        const outTime  = new Date(inTime.getTime() + duration * 60000);
        reportRecords.push({
            slot: rc(slots), zone: rc(zones),
            in: inTime, out: outTime,
            vehicle: veh(),
            duration,
            price: (duration * 1.1).toFixed(2)
        });
    }
    reportRecords.sort((a, b) => b.in - a.in);
})();

// ── GET /report  ──────────────────────────────────────────
app.get('/report', (req, res) => {
    const query  = (req.query.vehicle || '').trim();
    const fmt    = d => d.toLocaleString('en-IN', {
        day:'2-digit', month:'2-digit', year:'numeric',
        hour:'2-digit', minute:'2-digit', hour12:false,
        timeZone:'Asia/Kolkata'
    });

    // Search result
    let resultCard = '';
    if (query) {
        const found = reportRecords.find(r => r.vehicle.toLowerCase() === query.toLowerCase());
        if (found) {
            resultCard = `
            <div class="result-card">
              <div class="result-title">✅ Vehicle Found</div>
              <div class="result-grid">
                <span><b>Vehicle</b>${found.vehicle}</span>
                <span><b>Zone</b>${found.zone}</span>
                <span><b>Slot</b>${found.slot}</span>
                <span><b>In Time</b>${fmt(found.in)}</span>
                <span><b>Out Time</b>${fmt(found.out)}</span>
                <span><b>Duration</b>${found.duration} min</span>
                <span><b>Price Paid</b>₹${found.price}</span>
              </div>
            </div>`;
        } else {
            resultCard = `<div class="result-card not-found">❌ Vehicle <b>${query}</b> not found in parking records.</div>`;
        }
    }

    const totalRevenue = reportRecords.reduce((s, r) => s + parseFloat(r.price), 0).toFixed(2);
    const avgDuration  = Math.round(reportRecords.reduce((s, r) => s + r.duration, 0) / reportRecords.length);

    const rows = reportRecords.map((r, i) => `
        <tr>
          <td>${i+1}</td><td>${r.slot}</td><td>${r.zone}</td>
          <td>${fmt(r.in)}</td><td>${fmt(r.out)}</td>
          <td class="vnum">${r.vehicle}</td><td>₹${r.price}</td>
        </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>TRINETRA — Parking Report</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:#87CEFA;font-family:'Poppins',Arial,sans-serif;text-align:center;padding-bottom:48px;}
  h1{font-size:38px;margin-top:28px;color:#083c5a;font-weight:700;}
  .subtitle{color:#0a3d62;font-size:14px;margin:4px 0 20px;}
  /* KPIs */
  .kpi-row{display:flex;justify-content:center;gap:20px;margin:16px auto 24px;max-width:760px;flex-wrap:wrap;}
  .kpi{background:#0a3d62;color:#fff;border-radius:12px;padding:14px 28px;min-width:150px;}
  .kpi .num{font-size:26px;font-weight:700;}
  .kpi .lbl{font-size:11px;opacity:.8;margin-top:2px;}
  /* Search */
  .search-bar{margin:0 auto 18px;display:flex;justify-content:center;gap:8px;flex-wrap:wrap;}
  .search-bar input{padding:10px 16px;font-size:15px;width:260px;border-radius:8px;border:1px solid #aaa;font-family:inherit;}
  .search-bar button{padding:10px 22px;font-size:15px;background:#0a3d62;color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:inherit;}
  /* Live filter */
  .filter-bar{margin:0 auto 12px;display:flex;justify-content:center;}
  .filter-bar input{padding:8px 14px;font-size:14px;width:280px;border-radius:8px;border:1px solid #aaa;font-family:inherit;}
  /* Result card */
  .result-card{margin:0 auto 20px;background:#fff;border-radius:12px;padding:20px 28px;display:inline-block;
    box-shadow:0 0 14px rgba(0,0,0,.15);text-align:left;min-width:320px;max-width:640px;}
  .result-card.not-found{color:#c53030;font-size:16px;text-align:center;}
  .result-title{font-size:17px;font-weight:700;color:#083c5a;margin-bottom:14px;}
  .result-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
  .result-grid span{background:#f0f4f8;border-radius:8px;padding:8px 12px;font-size:13px;}
  .result-grid b{display:block;font-size:11px;color:#718096;margin-bottom:2px;}
  /* Table */
  table{margin:auto;border-collapse:collapse;background:#fff;width:90%;box-shadow:0 0 16px rgba(0,0,0,.15);border-radius:12px;overflow:hidden;}
  th{background:#0a3d62;color:#fff;padding:11px 10px;font-size:13px;}
  td{padding:8px 10px;font-size:13px;}
  tr:nth-child(even){background:#f0f4f8;}
  tr:hover{background:#dbeafe;}
  tr.hidden-row{display:none;}
  tfoot td{background:#0a3d62;color:#fff;font-weight:700;padding:10px;}
  /* Buttons */
  .btn-row{margin:16px auto;display:flex;justify-content:center;gap:12px;flex-wrap:wrap;}
  .btn{padding:10px 26px;font-size:14px;background:#0a3d62;color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:inherit;}
  .btn.outline{background:#fff;color:#0a3d62;border:2px solid #0a3d62;}
  @media print{.btn-row,.search-bar,.filter-bar{display:none;}body{background:#fff;}}
</style>
</head>
<body>
<img src="/imgtri.png" alt="TRINETRA Logo" style="height: 100px; width: auto; object-fit: contain; margin: 30px auto; display: block; border-radius: 50%; background: white; padding: 2px; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.2));">
<h1>🅿 TRINETRA — Parking Report</h1>
<div class="subtitle">TRINETRA — Last 3 Days &nbsp;|&nbsp; Generated: ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}</div>

<div class="kpi-row">
  <div class="kpi"><div class="num">${reportRecords.length}</div><div class="lbl">Total Vehicles</div></div>
  <div class="kpi"><div class="num">₹${totalRevenue}</div><div class="lbl">Total Revenue</div></div>
  <div class="kpi"><div class="num">${avgDuration} min</div><div class="lbl">Avg Duration</div></div>
  <div class="kpi"><div class="num">${parkingStatus.slotA1 === 'occupied' ? '🔴 Occ' : '🟢 Free'}</div><div class="lbl">Live Slot A1</div></div>
</div>

<!-- Search by vehicle number (server-side) -->
<form class="search-bar" method="GET" action="/report">
  <input type="text" name="vehicle" placeholder="Search vehicle number e.g. HR 23 AB 4567"
         value="${query}" autocomplete="off">
  <button type="submit">🔍 Search</button>
  ${query ? '<a href="/report"><button type="button" class="btn outline">✕ Clear</button></a>' : ''}
</form>

${resultCard}

<div class="btn-row">
  <button class="btn" onclick="window.print()">🖨 Print / Save as PDF</button>
</div>

<!-- Live filter (client-side) -->
<div class="filter-bar">
  <input type="text" id="liveFilter" placeholder="Filter table by any column..." oninput="filterTable(this.value)">
</div>

<table>
  <thead>
    <tr><th>S.No</th><th>Slot</th><th>Zone</th><th>In Time</th><th>Out Time</th><th>Vehicle Number</th><th>Price (₹)</th></tr>
  </thead>
  <tbody id="reportBody">${rows}</tbody>
  <tfoot>
    <tr><td colspan="6">Total Revenue (${reportRecords.length} vehicles)</td><td>₹${totalRevenue}</td></tr>
  </tfoot>
</table>

<script>
function filterTable(q) {
  q = q.toLowerCase();
  document.querySelectorAll('#reportBody tr').forEach(tr => {
    tr.classList.toggle('hidden-row', !tr.innerText.toLowerCase().includes(q));
  });
}
</script>
</body></html>`;

    res.send(html);
});




// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log('\n==============================================');
    console.log('  TRINETRA Parking API Server — Running!');
    console.log(`  Endpoint : http://localhost:${PORT}/parking-status`);
    console.log('==============================================\n');
    // initSerial(); // Disabled: Let backend.py handle Arduino Serial to avoid COM Port clashes
});
