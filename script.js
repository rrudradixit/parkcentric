// Enterprise Data Models
const ZONES = ['1', '2', '3'];
const SLOTS_PER_ZONE = 8;
const TOTAL_SLOTS = ZONES.length * SLOTS_PER_ZONE;

// Configuration & Rates
const ZONE_RATES = {
    '1': 5, // Premium
    '2': 3, // Standard
    '3': 1  // Economy
};

// State
let parkingState = {};
let occupancyHistory = [];
let chartInstance = null;
let revChartInstance = null;
let distChartInstance = null;
let activeCars = [];
let pricingDisplayCarId = null;
let isQuickPark = false;

// UI State trackers
let isProcessingEntry = false;

class Car {
    constructor(id) {
        this.id = id;
        this.entryTime = new Date();
        this.zone = null;
    }
}

// Initialization
function init() {
    updateTime();
    setInterval(updateTime, 1000);

    initNavigation();
    initGrid();
    initChart();

    // Quick Park Toggle listener
    document.getElementById('quick-park-toggle').addEventListener('change', (e) => {
        isQuickPark = e.target.checked;
        if (isQuickPark) {
            document.getElementById('rec-reason').innerText = "Quick Park active: Prioritizing Exit proximity (Zone C).";
        }
    });

    // Start simulation loop based on a robust ticker
    setInterval(simulationTick, 2500); // Ticks every 2.5s
    updatePricingPanelRandomTick();
    setInterval(updatePricingPanelRandomTick, 1000);
    
    // Connect to Hardware Serial Bridge
    initHardwareBridge();
}

// ==========================================
// HARDWARE BRIDGE: ARDUINO WEBSOCKET (FASTAPI)
// ==========================================
let ws = null;

function initHardwareBridge() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log('[Dashboard] Connection already in progress or open. Skipping...');
        return;
    }

    // Using 127.0.0.1 to avoid potential 'localhost' resolution issues on some Windows setups
    const wsUrl = 'ws://127.0.0.1:8080';
    console.log(`[Dashboard] Attempting to connect to Hardware Bridge → ${wsUrl}`);
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('%c[Dashboard] SUCCESS: Connected to API Network', 'color: #00ff88; font-weight: bold');
        document.getElementById('lat-text').innerHTML = 
            `Network API: <span style="color:var(--color-green);font-weight:700">CONNECTED</span>`;
        document.getElementById('lat-ind').className = 'h-indicator green';
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log("[WS INCOMING]:", data);
            
            // 1. Log to UI Sensor Feed
            const feed = document.getElementById('sensor-feed');
            if (feed) {
                const time = new Date().toLocaleTimeString([], {hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit'});
                let msg = data.type;
                if (data.type === 'SENSOR_UPDATE') msg = `${data.slot}:${data.status}`;
                if (data.type === 'SERIAL_STATUS') msg = `SERIAL:${data.connected ? 'READY' : 'LOST'}`;
                
                feed.innerHTML = `<div><span style="opacity:0.5">[${time}]</span> ${msg}</div>` + feed.innerHTML;
                if (feed.children.length > 10) feed.removeChild(feed.lastChild);
            }

            // 2. Handle System Messages
            if (data.type === 'INIT_STATUS') {
                updateSerialUI(data.serial_ready);
                // Optionally sync other slots here if needed
            }

            if (data.type === 'SERIAL_STATUS') {
                updateSerialUI(data.connected);
            }

            if (data.type === 'HEARTBEAT') {
                updateSerialUI(data.serial_ready);
            }

            // 3. Handle Sensor Updates
            if (data.type === 'SENSOR_UPDATE' && data.slot === '1-1') {
                console.log(`[Hardware Action] Slot 1-1 status update: ${data.status}`);
                handleHardwareSlotUpdate(data.slot, data.status);
            }
        } catch (err) {
            console.error('[WS ERROR] Failed to parse message:', err);
        }
    };

    ws.onclose = () => {
        console.warn('[Dashboard] Disconnected from Hardware Bridge. Retrying in 5 seconds...');
        const feed = document.getElementById('sensor-feed');
        if (feed) feed.innerHTML = `<div style="color:var(--color-red)">> CONNECTION LOST</div>` + feed.innerHTML;
        
        document.getElementById('lat-text').innerHTML = 
            `Network API: <span style="color:var(--color-red);font-weight:700">DISCONNECTED</span>`;
        document.getElementById('lat-ind').className = 'h-indicator red';
        updateSerialUI(false); // Assume serial is lost if network is lost
        setTimeout(initHardwareBridge, 5000);
    };

    ws.onerror = (err) => {
        console.error('[WS ERROR] WebSocket error:', err);
    };
}

function updateSerialUI(isConnected) {
    const serText = document.getElementById('ser-text');
    const serInd  = document.getElementById('ser-ind');
    if (!serText || !serInd) return;

    if (isConnected) {
        serText.innerHTML = `Arduino Serial: <span style="color:var(--color-green);font-weight:700">CONNECTED</span>`;
        serInd.className = 'h-indicator green';
    } else {
        serText.innerHTML = `Arduino Serial: <span style="color:var(--color-red);font-weight:700">OFFLINE</span>`;
        serInd.className = 'h-indicator red';
    }
}

// Manual Simulation for Testing UI without Hardware
function simulateHardwareA1() {
    console.log("[Sim] Triggering Manual 1-1 'OCCUPIED' state...");
    const feed = document.getElementById('sensor-feed');
    if (feed) feed.innerHTML = `<div><span style="opacity:0.5">[SIM]</span> 1-1:OCCUPIED (Manual)</div>` + feed.innerHTML;
    handleHardwareSlotUpdate('1-1', 'OCCUPIED');
}

function handleHardwareSlotUpdate(slotId, status) {
    const slotEl = document.getElementById(`slot-${slotId}`);
    const zone   = slotId.charAt(0);
    const slotObj = parkingState[zone] && parkingState[zone].find(s => s.id === slotId);

    if (!slotEl || !slotObj) return;

    const isOccupied = status === 'OCCUPIED';

    if (isOccupied && !slotObj.occupied) {
        // Physical Arrival
        const liveCar = new Car(generatePlate());
        liveCar.zone = slotObj.zone;
        slotObj.occupied = true;
        slotObj.car = liveCar;
        activeCars.push(liveCar);
        slotEl.classList.add('occupied');
        
        // Show in UI
        document.getElementById('det-plate').innerText = liveCar.id;
        document.getElementById('det-status').innerText = `Vehicle detected in ${slotId}`;
        document.getElementById('det-status').className = 'det-status text-red';
        document.getElementById('det-slot').innerText  = `OCCUPIED: ${slotId}`;
        glowPanel('det-panel');
        setTimeout(resetDetectionPanel, 5000);

    } else if (!isOccupied && slotObj.occupied) {
        // Physical Departure
        if (slotObj.car) {
            showPricingReceipt(slotObj.car);
            const carIndex = activeCars.findIndex((car) => car.id === slotObj.car.id);
            if (carIndex > -1) activeCars.splice(carIndex, 1);
        }
        slotObj.occupied = false;
        slotObj.car = null;
        slotEl.classList.remove('occupied');

        // Reset panel
        document.getElementById('det-plate').innerText = 'GATE IDLE';
        document.getElementById('det-status').innerText = `${slotId} now vacant.`;
        document.getElementById('det-status').className = 'det-status text-green';
        document.getElementById('det-slot').innerText  = '-';
    }

    updateAnalytics();
}

// Sub-routines

function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.page-section');
    const pageTitle = document.getElementById('page-title');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navItems.forEach(nav => nav.classList.remove('active'));
            sections.forEach(sec => sec.classList.add('hidden'));

            item.classList.add('active');
            const targetId = item.getAttribute('data-target');
            document.getElementById(targetId).classList.remove('hidden');

            const cleanName = item.textContent.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

            if (targetId === 'sec-dashboard') {
                pageTitle.innerText = "Real-Time Operations";
            } else {
                pageTitle.innerText = cleanName;
            }

            if (targetId === 'sec-analytics' && !revChartInstance) {
                initSecondaryCharts();
            }
        });
    });
}

function updateTime() {
    const now = new Date();
    document.getElementById('current-time').innerText = now.toLocaleString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

// Generate Grid (Pre-fill some realistic data)
function initGrid() {
    ZONES.forEach(zone => {
        parkingState[zone] = [];
        const container = document.getElementById(`slots-${zone}`);

        for (let i = 1; i <= SLOTS_PER_ZONE; i++) {
            const slotId = `${zone}-${i}`;
            const isOccupied = false;

            const slotData = {
                id: slotId,
                zone: zone,
                occupied: isOccupied,
                car: null
            };

            if (isOccupied) {
                slotData.car = new Car(generatePlate());
                slotData.car.zone = zone;
                // Stagger entry times for historic realism
                const pastMinutes = Math.floor(Math.random() * 120) + 10;
                slotData.car.entryTime = new Date(Date.now() - pastMinutes * 60000);
                activeCars.push(slotData.car);
            }
            parkingState[zone].push(slotData);

            const slotEl = document.createElement('div');
            slotEl.className = `slot ${isOccupied ? 'occupied' : ''}`;
            slotEl.id = `slot-${slotId}`;
            slotEl.innerText = i; // Just show "1", "2", etc.
            container.appendChild(slotEl);
        }
    });
}

// ----- ENTERPRISE ENGINE LOGIC -----
function simulationTick() {
    // Random vehicle arrival and departure simulation disabled as requested 
    // This ensures all parking slots remain continuously empty (green)
    updateAnalytics(); // Keeps the live charts ticking with the 0% data
}

// Flow 1: Arrival Pipeline
function handleArrival() {
    // 1. Detect Vehicle
    isProcessingEntry = true;
    const newCar = new Car(generatePlate());

    // UI: Plate Scanned
    document.getElementById('det-plate').innerText = newCar.id;
    document.getElementById('det-status').innerText = 'Vehicle Authorized. Requesting routing...';
    document.getElementById('det-slot').innerText = '-';
    glowPanel('det-panel');

    // 2. Routing Decision (Simulate backend latency)
    setTimeout(() => {
        const selectedSlot = engineRouteRecommendation();
        if (!selectedSlot) {
            // Facility Full
            document.getElementById('det-status').innerText = 'Facility FULL. Access Denied.';
            document.getElementById('det-status').className = 'det-status text-red';
            setTimeout(() => { resetDetectionPanel(); }, 3000);
            return;
        }

        // 3. Output Recommendation UI
        newCar.zone = selectedSlot.zone;
        glowPanel('rec-panel');
        document.getElementById('rec-zone').innerText = selectedSlot.zone;

        let dist = selectedSlot.zone === 'A' ? 20 : (selectedSlot.zone === 'B' ? 50 : 85);
        let congList = ['Low', 'Moderate', 'High'];
        let zOcc = parkingState[selectedSlot.zone].filter(s => s.occupied).length;
        let cLvl = zOcc < 3 ? 'Low' : (zOcc < 6 ? 'Moderate' : 'High');

        document.getElementById('rec-dist').innerText = `Walking Dist: ${dist}m`;
        document.getElementById('rec-cong').innerText = `Congestion: ${cLvl}`;

        if (isQuickPark && selectedSlot.zone === 'C') {
            document.getElementById('rec-reason').innerText = `⚡ Quick Park directed to Zone C (Near Exit).`;
        } else {
            document.getElementById('rec-reason').innerText = `Optimized for ${selectedSlot.zone === 'A' ? 'Distance' : 'Availability'}.`;
        }

        // Draw Map Route
        drawBlueprintRoute(selectedSlot.zone);

        // 4. Final Slot Assignment
        document.getElementById('det-status').innerText = 'Routing to slot...';
        document.getElementById('det-status').className = 'det-status text-green';
        document.getElementById('det-slot').innerText = `ASSIGNED: ${selectedSlot.id}`;

        setTimeout(() => {
            // Apply to grid
            selectedSlot.occupied = true;
            selectedSlot.car = newCar;
            activeCars.push(newCar);
            document.getElementById(`slot-${selectedSlot.id}`).classList.add('occupied');
            showPricingReceipt(newCar);
            glowPanel('pricing-panel');

            updateAnalytics();

            // Wait 1.5s before clearing Entry UI
            setTimeout(() => { resetDetectionPanel(); }, 1500);
        }, 1500);

    }, 800);
}

// Flow 2: Departure Pipeline
function handleDeparture() {
    const occupiedSlots = getAllSlots().filter(s => s.occupied);
    if (occupiedSlots.length > 0) {
        const randomSlot = occupiedSlots[Math.floor(Math.random() * occupiedSlots.length)];

        if (randomSlot.car) {
            // Calculate and show ticket logic
            showPricingReceipt(randomSlot.car);
            glowPanel('pricing-panel');

            const idx = activeCars.findIndex(c => c.id === randomSlot.car.id);
            if (idx > -1) activeCars.splice(idx, 1);
        }

        randomSlot.occupied = false;
        randomSlot.car = null;
        document.getElementById(`slot-${randomSlot.id}`).classList.remove('occupied');

        updateAnalytics();
    }
}

function engineRouteRecommendation() {
    // Returns a slot object tailored to conditions
    const availableSlots = getAllSlots().filter(s => !s.occupied);
    if (availableSlots.length === 0) return null;

    let targetZone = 'A';

    const zoneStats = ZONES.map(z => ({
        id: z,
        free: parkingState[z].filter(s => !s.occupied).length
    }));

    if (isQuickPark) {
        // Quick Park prefers C, then B, then A
        if (zoneStats.find(z => z.id === 'C').free > 0) targetZone = 'C';
        else if (zoneStats.find(z => z.id === 'B').free > 0) targetZone = 'B';
        else targetZone = 'A';
    } else {
        // Normal prioritizes A (Entrance), then B, then C.
        if (zoneStats.find(z => z.id === 'A').free > 0) targetZone = 'A';
        else if (zoneStats.find(z => z.id === 'B').free > 0) targetZone = 'B';
        else targetZone = 'C';
    }

    // Pick random available slot in target zone
    const targetSlots = parkingState[targetZone].filter(s => !s.occupied);
    return targetSlots[Math.floor(Math.random() * targetSlots.length)];
}

function resetDetectionPanel() {
    document.getElementById('det-plate').innerText = 'GATE IDLE';
    document.getElementById('det-status').innerText = 'Monitoring entrance.';
    document.getElementById('det-status').className = 'det-status text-muted';
    document.getElementById('det-slot').innerText = '-';

    document.getElementById('route-svg').innerHTML = '<path id="route-path-elem" class="route-path" d="" fill="none"></path>';
    document.getElementById('rec-zone').innerText = '-';
    document.getElementById('rec-reason').innerText = 'Awaiting vehicle...';
    document.getElementById('rec-dist').innerText = '--';
    document.getElementById('rec-cong').innerText = '--';

    isProcessingEntry = false;
}

function drawBlueprintRoute(zone) {
    const svg = document.getElementById('route-svg');
    // viewBox is 300 180
    // Entrance approx (30, 25)
    // Exit approx (30, 160)
    // Zone A approx (230, 30)
    // Zone B approx (230, 90)
    // Zone C approx (230, 150)

    let pathObj = "";
    if (zone === 'A') {
        pathObj = "M30,25 C80,25 150,35 200,35";
    } else if (zone === 'B') {
        pathObj = "M30,25 L30,90 L200,90";
    } else {
        pathObj = "M30,25 L30,150 L200,150";
    }

    svg.innerHTML = `
        <path class="route-path" d="${pathObj}"></path>
        <circle r="4" fill="#00D2FF">
            <animateMotion dur="1.5s" repeatCount="indefinite" path="${pathObj}" />
        </circle>
    `;

    // Highlight zone box temporarily
    document.getElementById(`bp-z-${zone}`).style.borderColor = "var(--color-primary)";
    setTimeout(() => { document.getElementById(`bp-z-${zone}`).style.borderColor = "rgba(0,210,255,0.2)"; }, 2000);
}

// ----- PRICING ENGINE -----
function calculatePeakMultiplier(currentUtil) {
    if (currentUtil > 75) return 2.0;
    if (currentUtil > 60) return 1.5;
    return 1.0;
}

function showPricingReceipt(car) {
    pricingDisplayCarId = car.id;
    const now = new Date();
    const msDiff = now - car.entryTime;
    const totalSeconds = Math.max(1, Math.floor(msDiff / 1000));
    const chargeSteps = Math.floor(totalSeconds / 10);
    const durationMinutes = Math.floor(totalSeconds / 60);
    const durationSeconds = totalSeconds % 60;
    const durationText = `${durationMinutes}:${String(durationSeconds).padStart(2, '0')}`;
    const ratePerMin = 1.1;
    const finalCharge = ((totalSeconds / 60) * ratePerMin).toFixed(2);

    document.getElementById('peak-indicator').innerText = `Flat Rate (Rs 1.1/min)`;
    document.getElementById('peak-indicator').className = "p-value peak-badge";

    document.getElementById('price-vehicle').innerText = car.id;
    document.getElementById('price-zone').innerText = `Zone ${car.zone} (Rs 1.1/min)`;
    document.getElementById('price-entry').innerText = formatTime12(car.entryTime);
    document.getElementById('price-duration-tag').innerText = `Duration: ${durationText}`;
    document.getElementById('price-duration').innerText = `${durationText}`;
    document.getElementById('price-charge').innerText = `Rs ${finalCharge}`;
}

function updatePricingPanelRandomTick() {
    if (activeCars.length === 0) {
        pricingDisplayCarId = null;
        document.getElementById('peak-indicator').innerText = 'Flat Rate (Rs 0.10/10 sec)';
        document.getElementById('peak-indicator').className = "p-value peak-badge";
        document.getElementById('price-vehicle').innerText = '-';
        document.getElementById('price-zone').innerText = '-';
        document.getElementById('price-entry').innerText = '-';
        document.getElementById('price-duration-tag').innerText = 'Duration: 0:00';
        document.getElementById('price-duration').innerText = '-';
        document.getElementById('price-charge').innerText = 'Rs 0.00';
        return;
    }

    const activeDisplayCar = activeCars.find((car) => car.id === pricingDisplayCarId);
    if (activeDisplayCar) {
        showPricingReceipt(activeDisplayCar);
        return;
    }

    showPricingReceipt(activeCars[0]);
}

// ----- ANALYTICS & HEALTH -----
function simulateHealthFluctuations() {
    const latSpan = document.getElementById('lat-val');
    const latInd = document.getElementById('lat-ind');

    let randLat = Math.floor(Math.random() * 60) + 15;
    if (Math.random() > 0.95) randLat += 150; // Random spike

    latSpan.innerText = randLat;
    if (randLat > 100) {
        latInd.className = "h-indicator red";
        document.getElementById('lat-text').style.color = "var(--color-red)";
    } else if (randLat > 50) {
        latInd.className = "h-indicator yellow";
        document.getElementById('lat-text').style.color = "var(--color-yellow)";
    } else {
        latInd.className = "h-indicator green";
        document.getElementById('lat-text').style.color = "#e2e8f0";
    }
}

function updateAnalytics() {
    const slots = getAllSlots();
    const occupied = slots.filter(s => s.occupied).length;
    const available = TOTAL_SLOTS - occupied;
    const util = Math.round((occupied / TOTAL_SLOTS) * 100);

    // Animate Counters (simple assignment, DOM treats it clean)
    document.getElementById('val-available').innerText = available;
    document.getElementById('val-occupied').innerText = occupied;
    document.getElementById('val-utilization').innerText = `${util}%`;

    // Active table sync
    if (document.getElementById('sec-zones').classList.contains('hidden') === false) {
        document.getElementById('tz-1-occ').innerText = parkingState['1'].filter(s => s.occupied).length;
        document.getElementById('tz-2-occ').innerText = parkingState['2'].filter(s => s.occupied).length;
        document.getElementById('tz-3-occ').innerText = parkingState['3'].filter(s => s.occupied).length;
    }

    // Chart Push
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    occupancyHistory.push({ time: timeStr, util: util, predicted: Math.min(100, util + Math.floor(Math.random() * 10 - 2)) });
    if (occupancyHistory.length > 20) occupancyHistory.shift();

    updateMultiChart();
    if (distChartInstance) updateDistributionChart();

    // Update zone traffic animations
    updateZoneTraffic();
}

// ── Zone Traffic Animations ───────────────────────────────
// Maps each zone's occupancy % to a traffic level class + badge label
// Updates BOTH the parking grid zones AND the Facility Blueprint mini-map
function updateZoneTraffic() {
    ZONES.forEach(zone => {
        const total = SLOTS_PER_ZONE;
        const occ   = parkingState[zone].filter(s => s.occupied).length;
        const pct   = (occ / total) * 100;

        // Determine traffic level
        let level, label, emoji;
        if (pct >= 88) {
            level = 'traffic-critical'; label = 'CRITICAL'; emoji = '🔴';
        } else if (pct >= 62) {
            level = 'traffic-high';     label = 'High';     emoji = '🟠';
        } else if (pct >= 38) {
            level = 'traffic-medium';   label = 'Medium';   emoji = '🟡';
        } else {
            level = 'traffic-low';      label = 'Low';      emoji = '🟢';
        }

        // ── Parking Grid zone ──────────────────────────
        const zoneEl = document.getElementById(`zone-${zone}`);
        if (zoneEl) zoneEl.className = `zone ${level}`;

        const badge = document.getElementById(`traffic-${zone}`);
        if (badge) {
            badge.className = `traffic-badge ${level}`;
            badge.innerHTML = `${emoji} ${label} &nbsp;<span style="opacity:.7;font-weight:400">${occ}/${total}</span>`;
        }

        const bar = document.getElementById(`tbar-${zone}`);
        if (bar) bar.style.width = `${pct}%`;

        // ── Facility Blueprint mini-map zone ───────────
        const bpZone = document.getElementById(`bp-z-${zone}`);
        if (bpZone) {
            // Keep bp-a/bp-b/bp-c position classes + add traffic class
            const posClass = zone === 'A' ? 'bp-a' : zone === 'B' ? 'bp-b' : 'bp-c';
            bpZone.className = `bp-zone ${posClass} ${level}`;
        }

        const bpBar = document.getElementById(`bpbar-${zone}`);
        if (bpBar) bpBar.style.width = `${pct}%`;

        const bpBadge = document.getElementById(`bpbadge-${zone}`);
        if (bpBadge) bpBadge.textContent = `${emoji} ${label} ${occ}/${total}`;
    });
}



// ----- UTIL -----
function getAllSlots() {
    let all = [];
    ZONES.forEach(zone => { all = all.concat(parkingState[zone]); });
    return all;
}

function generatePlate() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const L1 = letters[Math.floor(Math.random() * 26)] + letters[Math.floor(Math.random() * 26)];
    const N1 = Math.floor(Math.random() * 90) + 10;
    const L2 = letters[Math.floor(Math.random() * 26)] + letters[Math.floor(Math.random() * 26)];
    const N2 = Math.floor(Math.random() * 9000) + 1000;
    return `${L1}-${N1}-${L2}-${N2}`;
}

function formatTime12(date) {
    let hours = date.getHours();
    let minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    minutes = minutes < 10 ? '0' + minutes : minutes;
    return hours + ':' + minutes + ' ' + ampm;
}

function glowPanel(id) {
    const el = document.getElementById(id);
    if (el) {
        el.classList.add('active-update');
        setTimeout(() => el.classList.remove('active-update'), 1200);
    }
}

// ----- CHARTS -----
Chart.defaults.color = '#94A3B8';
Chart.defaults.font.family = "'Poppins', 'Inter', sans-serif";

function initChart() {
    const ctx = document.getElementById('occupancyChart').getContext('2d');

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Actual Occupancy (%)',
                    data: [],
                    borderColor: '#00D2FF', // TRINETRA Cyan
                    backgroundColor: 'rgba(0, 210, 255, 0.15)',
                    borderWidth: 3,
                    tension: 0.3,
                    fill: true,
                    pointRadius: 2
                },
                {
                    label: 'Predicted Trend (%)',
                    data: [],
                    borderColor: 'rgba(0, 102, 255, 0.7)', // Cyber Blue dashed
                    borderWidth: 2,
                    borderDash: [5, 5],
                    tension: 0.4,
                    fill: false,
                    pointRadius: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top', align: 'end' },
                tooltip: { mode: 'index', intersect: false }
            },
            scales: {
                y: { min: 0, max: 100, grid: { color: 'rgba(255, 255, 255, 0.05)' } },
                x: { grid: { display: false } }
            },
            animation: { duration: 0 } // Prevent bouncy updates every tick
        }
    });
}

function updateMultiChart() {
    if (!chartInstance) return;
    chartInstance.data.labels = occupancyHistory.map(h => h.time);
    chartInstance.data.datasets[0].data = occupancyHistory.map(h => h.util);
    chartInstance.data.datasets[1].data = occupancyHistory.map(h => h.predicted);
    chartInstance.update();
}

function initSecondaryCharts() {
    const ctxRev = document.getElementById('revenueChart').getContext('2d');
    revChartInstance = new Chart(ctxRev, {
        type: 'bar',
        data: {
            labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
            datasets: [{
                label: 'Revenue (₹)',
                data: [45000, 48000, 42500, 52000, 71000, 82000, 68000], // Scaled up values for reality
                backgroundColor: 'rgba(0, 210, 255, 0.5)',
                borderColor: '#00D2FF',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { grid: { color: 'rgba(255,255,255,0.05)' } }, x: { grid: { display: false } } }
        }
    });

    const ctxDist = document.getElementById('distributionChart').getContext('2d');
    distChartInstance = new Chart(ctxDist, {
        type: 'doughnut',
        data: {
            labels: ['Zone A (Premium)', 'Zone B (Std)', 'Zone C (Eco)'],
            datasets: [{
                data: [1, 1, 1],
                backgroundColor: ['#00D2FF', '#0070F3', '#38BDF8'],
                borderWidth: 0, hoverOffset: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '75%',
            plugins: { legend: { position: 'bottom', labels: { color: '#e2e8f0' } } }
        }
    });
    updateDistributionChart();
}

function updateDistributionChart() {
    if (!distChartInstance) return;
    const oA = parkingState['1'] ? parkingState['1'].filter(s => s.occupied).length : 0;
    const oB = parkingState['2'] ? parkingState['2'].filter(s => s.occupied).length : 0;
    const oC = parkingState['3'] ? parkingState['3'].filter(s => s.occupied).length : 0;
    if (oA + oB + oC === 0) distChartInstance.data.datasets[0].data = [1, 1, 1];
    else distChartInstance.data.datasets[0].data = [oA, oB, oC];
    distChartInstance.update();
}

// ── Auth ───────────────────────────────────────────────────
function logout() {
    sessionStorage.removeItem('pc_auth');
    sessionStorage.removeItem('pc_user');
    window.location.href = 'login.html';
}

// Show logged-in user email in banner
(function() {
    const user = sessionStorage.getItem('pc_user') || '';
    const el = document.getElementById('banner-user');
    if (el && user) el.textContent = '👤 ' + user;
})();

// Trigger initializations
window.addEventListener('DOMContentLoaded', init);

// ==========================================
// EXPORT REPORT
// Redirects to Server-Side Report
// ==========================================
function exportReport() {
    window.open('report.html', '_blank');
}

