// ==========================================
// CleanStreet - Real GPS Tracking & Leaflet Maps
// OpenStreetMap & Browser Geolocation API
// ==========================================

const TELEMETRY_KEY = 'cleanstreet_worker_telemetry';
const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// Cross-tab broadcast channel
let telemetryChannel = null;
try {
  telemetryChannel = new BroadcastChannel('cleanstreet_telemetry_channel');
} catch (e) {
  // Fallback to window storage events if BroadcastChannel is unsupported
  telemetryChannel = null;
}

// Map instances
let workerMap = null;
let residentMap = null;
let adminMap = null;

// Worker GPS state
let workerWatchId = null;
let workerOnDuty = true;
let workerMarker = null;
let workerAccuracyCircle = null;
let lastWorkerPosition = null;

// Resident & Admin markers
let residentWorkerMarker = null;
let adminWorkerMarker = null;

// Default map view (Bengaluru Jayanagar) used as map frame before GPS fix
const DEFAULT_CENTER = [12.9250, 77.5938];
const DEFAULT_ZOOM = 15;

// Tile layer setup (Free OpenStreetMap)
function createOsmTileLayer() {
  return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  });
}

// Custom Leaflet worker pulsating marker
const workerPulseIcon = L.divIcon({
  className: 'custom-worker-pin',
  html: '<div class="worker-marker-pulse" title="Worker Ravi K."></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
  popupAnchor: [0, -10]
});

// ------------------------------------------
// Screen Switching & Map Resizing
// ------------------------------------------
function go(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id));
  document.querySelectorAll('.switcher button').forEach(b => b.classList.toggle('on', b.dataset.s === id));
  window.scrollTo(0, 0);

  // Invalidate Leaflet sizes when switching to screens with hidden maps
  setTimeout(() => {
    if (id === 'worker' && workerMap) {
      workerMap.invalidateSize();
      if (lastWorkerPosition) {
        workerMap.setView([lastWorkerPosition.lat, lastWorkerPosition.lng], workerMap.getZoom());
      }
    } else if (id === 'public' && residentMap) {
      residentMap.invalidateSize();
      updateResidentCollectorView();
    } else if (id === 'admin' && adminMap) {
      adminMap.invalidateSize();
      updateAdminMapView();
    }
  }, 100);
}

document.querySelectorAll('.switcher button').forEach(b => b.onclick = () => go(b.dataset.s));

// ------------------------------------------
// Maps Initialization
// ------------------------------------------
function initMaps() {
  if (typeof L === 'undefined') {
    console.error('Leaflet library failed to load.');
    return;
  }

  // 1. Worker Map
  const workerContainer = document.getElementById('worker-map');
  if (workerContainer && !workerMap) {
    workerMap = L.map('worker-map', {
      zoomControl: true,
      attributionControl: true
    }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    createOsmTileLayer().addTo(workerMap);
  }

  // 2. Resident Map
  const residentContainer = document.getElementById('resident-map');
  if (residentContainer && !residentMap) {
    residentMap = L.map('resident-map', {
      zoomControl: true,
      attributionControl: true
    }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    createOsmTileLayer().addTo(residentMap);
  }

  // 3. Admin Map
  const adminContainer = document.getElementById('admin-map');
  if (adminContainer && !adminMap) {
    adminMap = L.map('admin-map', {
      zoomControl: true,
      attributionControl: true
    }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    createOsmTileLayer().addTo(adminMap);
  }

  // Update views with any existing telemetry
  updateResidentCollectorView();
  updateAdminMapView();
}

// ------------------------------------------
// Geolocation Tracking for Worker (Ravi K.)
// ------------------------------------------
function startWorkerGpsTracking() {
  const badge = document.getElementById('worker-gps-badge');
  const alertEl = document.getElementById('worker-map-alert');
  const accLabel = document.getElementById('worker-accuracy-label');

  if (!navigator.geolocation) {
    if (badge) {
      badge.textContent = 'GPS not supported';
      badge.className = 'badge b-bad';
    }
    showMapAlert(alertEl, 'alert-bad', 'Geolocation is not supported by your browser.');
    return;
  }

  if (badge) {
    badge.textContent = 'Acquiring GPS...';
    badge.className = 'badge b-visited';
  }
  if (accLabel) {
    accLabel.textContent = 'Requesting GPS satellite signal...';
  }
  hideMapAlert(alertEl);

  if (workerWatchId !== null) {
    navigator.geolocation.clearWatch(workerWatchId);
    workerWatchId = null;
  }

  const geoOptions = {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 5000
  };

  workerWatchId = navigator.geolocation.watchPosition(
    onWorkerGpsSuccess,
    onWorkerGpsError,
    geoOptions
  );
}

function stopWorkerGpsTracking() {
  if (workerWatchId !== null) {
    navigator.geolocation.clearWatch(workerWatchId);
    workerWatchId = null;
  }

  // Broadcast off-duty state
  const offDutyPayload = {
    workerId: 'worker-ravi-k',
    workerName: 'Ravi K.',
    role: 'Garbage Collector',
    status: 'off-duty',
    timestamp: Date.now()
  };
  broadcastTelemetry(offDutyPayload);

  const badge = document.getElementById('worker-gps-badge');
  if (badge) {
    badge.textContent = 'Off duty, GPS paused';
    badge.className = 'badge b-pending';
  }

  const accLabel = document.getElementById('worker-accuracy-label');
  if (accLabel) {
    accLabel.textContent = 'GPS paused while off duty';
  }
}

function toggleWorkerDuty() {
  const dutyBtn = document.getElementById('worker-duty-btn');
  workerOnDuty = !workerOnDuty;

  if (workerOnDuty) {
    if (dutyBtn) dutyBtn.textContent = 'End duty';
    startWorkerGpsTracking();
  } else {
    if (dutyBtn) dutyBtn.textContent = 'Start duty';
    stopWorkerGpsTracking();
  }
}

function recenterWorkerMap() {
  if (lastWorkerPosition && workerMap) {
    workerMap.setView([lastWorkerPosition.lat, lastWorkerPosition.lng], 16);
  } else if (workerMap) {
    workerMap.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  }
}

function onWorkerGpsSuccess(position) {
  if (!workerOnDuty) return;

  const lat = position.coords.latitude;
  const lng = position.coords.longitude;
  const accuracy = Math.round(position.coords.accuracy);
  const timestamp = position.timestamp || Date.now();

  const isFirstFix = !lastWorkerPosition;
  lastWorkerPosition = { lat, lng, accuracy, timestamp };

  // Update Worker Topbar Badge
  const badge = document.getElementById('worker-gps-badge');
  if (badge) {
    badge.textContent = `On duty, GPS active (\u00B1${accuracy}m)`;
    badge.className = 'badge b-done';
  }

  // Update accuracy label
  const accLabel = document.getElementById('worker-accuracy-label');
  if (accLabel) {
    const timeStr = new Date(timestamp).toLocaleTimeString();
    accLabel.textContent = `GPS Accuracy: \u00B1${accuracy}m \u00B7 Updated: ${timeStr}`;
  }

  // Hide any previous alert
  const alertEl = document.getElementById('worker-map-alert');
  hideMapAlert(alertEl);

  // Update Worker Leaflet Map Marker and Accuracy Circle
  if (workerMap) {
    if (!workerMarker) {
      workerMarker = L.marker([lat, lng], { icon: workerPulseIcon }).addTo(workerMap);
    } else {
      workerMarker.setLatLng([lat, lng]);
    }

    workerMarker.bindPopup(
      `<b>Ravi K. (Garbage Collector)</b><br>` +
      `<b>Status:</b> On duty (12th Main)<br>` +
      `<b>Coordinates:</b> ${lat.toFixed(5)}, ${lng.toFixed(5)}<br>` +
      `<b>Accuracy:</b> \u00B1${accuracy} meters`
    );

    if (!workerAccuracyCircle) {
      workerAccuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        color: '#2F8F5B',
        fillColor: '#2F8F5B',
        fillOpacity: 0.12,
        weight: 1
      }).addTo(workerMap);
    } else {
      workerAccuracyCircle.setLatLng([lat, lng]);
      workerAccuracyCircle.setRadius(accuracy);
    }

    if (isFirstFix) {
      workerMap.setView([lat, lng], 16);
    }
  }

  // Broadcast genuine location payload to other screens/tabs
  const telemetry = {
    workerId: 'worker-ravi-k',
    workerName: 'Ravi K.',
    role: 'Garbage Collector',
    lat: lat,
    lng: lng,
    accuracy: accuracy,
    timestamp: timestamp,
    status: 'on-duty',
    currentStreet: '12th Main, Jayanagar 4th Block'
  };

  broadcastTelemetry(telemetry);

  // Directly update resident and admin views in the same window
  updateResidentCollectorView();
  updateAdminMapView();
}

function onWorkerGpsError(error) {
  const badge = document.getElementById('worker-gps-badge');
  const alertEl = document.getElementById('worker-map-alert');
  const accLabel = document.getElementById('worker-accuracy-label');

  let errorTitle = 'GPS Error';
  let errorMsg = 'Could not acquire GPS coordinates.';

  switch (error.code) {
    case error.PERMISSION_DENIED:
      errorTitle = 'Location Permission Denied';
      errorMsg = 'Please allow location permission in your browser URL bar or settings to track live duty.';
      break;
    case error.POSITION_UNAVAILABLE:
      errorTitle = 'GPS Signal Unavailable';
      errorMsg = 'Device location is unavailable. Check if GPS / Location services are turned on.';
      break;
    case error.TIMEOUT:
      errorTitle = 'GPS Timeout';
      errorMsg = 'GPS satellite fix timed out. Still attempting to re-acquire...';
      break;
  }

  if (badge) {
    badge.textContent = errorTitle;
    badge.className = 'badge b-bad';
  }

  if (accLabel) {
    accLabel.textContent = `GPS error: ${errorMsg}`;
  }

  showMapAlert(alertEl, 'alert-bad', `<b>${errorTitle}:</b> ${errorMsg} <button class="btn ghost" style="padding:2px 8px;font-size:0.75rem;margin-left:8px" onclick="startWorkerGpsTracking()">Retry</button>`);
}

// ------------------------------------------
// Telemetry Broadcasting (Shared Storage & Channel)
// ------------------------------------------
function broadcastTelemetry(data) {
  try {
    localStorage.setItem(TELEMETRY_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('Could not save telemetry to localStorage:', e);
  }

  if (telemetryChannel) {
    try {
      telemetryChannel.postMessage(data);
    } catch (e) {
      console.warn('Could not post to telemetryChannel:', e);
    }
  }
}

function getStoredTelemetry() {
  try {
    const raw = localStorage.getItem(TELEMETRY_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Listen for updates from other tabs
if (telemetryChannel) {
  telemetryChannel.onmessage = () => {
    updateResidentCollectorView();
    updateAdminMapView();
  };
}

window.addEventListener('storage', (e) => {
  if (e.key === TELEMETRY_KEY) {
    updateResidentCollectorView();
    updateAdminMapView();
  }
});

// Periodic timer to keep relative time fresh and handle stale signals
setInterval(() => {
  updateResidentCollectorView();
  updateAdminMapView();
}, 4000);

// ------------------------------------------
// Public / Resident Dashboard Tracking
// ------------------------------------------
function updateResidentCollectorView() {
  const data = getStoredTelemetry();
  const alertEl = document.getElementById('resident-map-alert');
  const statusBadge = document.getElementById('resident-collector-status');
  const descEl = document.getElementById('resident-tracking-desc');

  if (!data || data.status !== 'on-duty' || !data.lat || !data.lng) {
    // Collector offline or no genuine data received yet
    if (residentWorkerMarker && residentMap) {
      residentMap.removeLayer(residentWorkerMarker);
      residentWorkerMarker = null;
    }
    if (statusBadge) {
      statusBadge.textContent = 'Collector GPS offline';
      statusBadge.className = 'badge b-pending';
    }
    if (descEl) {
      descEl.textContent = 'No genuine live collector GPS broadcast received yet. Open the Worker tab with GPS enabled to share coordinates.';
    }
    showMapAlert(
      alertEl,
      'alert-warning',
      '<b>Collector GPS Offline:</b> No active GPS broadcast from collector. When the worker starts duty and grants GPS, live location will appear here.'
    );
    return;
  }

  // Check if data is stale (> 2 minutes)
  const ageMs = Date.now() - (data.timestamp || 0);
  const secondsAgo = Math.max(1, Math.round(ageMs / 1000));

  if (ageMs > STALE_TIMEOUT_MS) {
    if (statusBadge) {
      statusBadge.textContent = 'Collector signal stale (>2m)';
      statusBadge.className = 'badge b-visited';
    }
    if (descEl) {
      descEl.textContent = `Last collector signal received ${Math.round(secondsAgo / 60)} min ago.`;
    }
    showMapAlert(
      alertEl,
      'alert-warning',
      `<b>Signal Stale:</b> Last verified GPS ping was ${secondsAgo} seconds ago. Waiting for next telemetry broadcast.`
    );
  } else {
    // Active genuine GPS data available
    hideMapAlert(alertEl);
    if (statusBadge) {
      statusBadge.textContent = `Collector live (\u00B1${data.accuracy}m)`;
      statusBadge.className = 'badge b-done';
    }
    if (descEl) {
      descEl.textContent = `Collector ${data.workerName} is on duty near ${data.currentStreet || 'your route'} (Updated ${secondsAgo}s ago).`;
    }
  }

  // Update Resident Map Marker
  if (residentMap) {
    const isFirstTime = !residentWorkerMarker;
    if (!residentWorkerMarker) {
      residentWorkerMarker = L.marker([data.lat, data.lng], { icon: workerPulseIcon }).addTo(residentMap);
    } else {
      residentWorkerMarker.setLatLng([data.lat, data.lng]);
    }

    residentWorkerMarker.bindPopup(
      `<b>Collector: ${data.workerName}</b><br>` +
      `<b>Status:</b> ${data.status === 'on-duty' ? 'On Duty' : 'Off Duty'}<br>` +
      `<b>Location:</b> ${data.currentStreet || 'In Transit'}<br>` +
      `<b>Accuracy:</b> \u00B1${data.accuracy}m<br>` +
      `<span style="color:#5D716B;font-size:0.8rem">Updated ${secondsAgo}s ago</span>`
    );

    if (isFirstTime) {
      residentMap.setView([data.lat, data.lng], 16);
    }
  }
}

function refreshResidentTelemetry() {
  updateResidentCollectorView();
  if (residentMap) {
    residentMap.invalidateSize();
    const data = getStoredTelemetry();
    if (data && data.lat && data.lng) {
      residentMap.setView([data.lat, data.lng], residentMap.getZoom());
    }
  }
}

// ------------------------------------------
// Admin Dashboard Tracking
// ------------------------------------------
function updateAdminMapView() {
  const data = getStoredTelemetry();
  const countBadge = document.getElementById('admin-worker-count-badge');
  const infoEl = document.getElementById('admin-map-info');
  const alertEl = document.getElementById('admin-map-alert');

  if (!data || data.status !== 'on-duty' || !data.lat || !data.lng) {
    if (adminWorkerMarker && adminMap) {
      adminMap.removeLayer(adminWorkerMarker);
      adminWorkerMarker = null;
    }
    if (countBadge) {
      countBadge.textContent = '0 workers active';
      countBadge.className = 'badge b-pending';
    }
    if (infoEl) {
      infoEl.textContent = '0 workers currently broadcasting real GPS telemetry. Workers appear when on duty.';
    }
    showMapAlert(
      alertEl,
      'alert-info',
      '<b>Telemetry Monitor:</b> 0 workers currently transmitting GPS coordinates. Start duty on the Worker screen to transmit genuine telemetry.'
    );
    return;
  }

  const ageMs = Date.now() - (data.timestamp || 0);
  const secondsAgo = Math.max(1, Math.round(ageMs / 1000));

  hideMapAlert(alertEl);

  if (countBadge) {
    countBadge.textContent = '1 worker active';
    countBadge.className = 'badge b-done';
  }

  if (infoEl) {
    infoEl.textContent = `1 worker (${data.workerName}) transmitting genuine GPS (Accuracy: \u00B1${data.accuracy}m \u00B7 ${secondsAgo}s ago).`;
  }

  if (adminMap) {
    const isFirstTime = !adminWorkerMarker;
    if (!adminWorkerMarker) {
      adminWorkerMarker = L.marker([data.lat, data.lng], { icon: workerPulseIcon }).addTo(adminMap);
    } else {
      adminWorkerMarker.setLatLng([data.lat, data.lng]);
    }

    adminWorkerMarker.bindPopup(
      `<b>Worker: ${data.workerName}</b><br>` +
      `<b>Route:</b> ${data.currentStreet || 'Jayanagar'}<br>` +
      `<b>Coordinates:</b> ${data.lat.toFixed(5)}, ${data.lng.toFixed(5)}<br>` +
      `<b>Accuracy:</b> \u00B1${data.accuracy}m<br>` +
      `<b>Last Ping:</b> ${secondsAgo}s ago`
    );

    if (isFirstTime) {
      adminMap.setView([data.lat, data.lng], 15);
    }
  }
}

// ------------------------------------------
// Helper: Map Alert Overlays
// ------------------------------------------
function showMapAlert(element, alertClass, htmlContent) {
  if (!element) return;
  element.className = `map-alert ${alertClass}`;
  element.innerHTML = htmlContent;
  element.style.display = 'block';
}

function hideMapAlert(element) {
  if (!element) return;
  element.style.display = 'none';
}

// ------------------------------------------
// Existing Worker Timer & Confirmation Logic
// ------------------------------------------
const DEMO_SECONDS = 10;
let t = null;
const simBtn = document.getElementById('sim');
if (simBtn) {
  simBtn.onclick = () => {
    clearInterval(t);
    let n = 0;
    t = setInterval(() => {
      n++;
      const timerEl = document.getElementById('timer');
      const barEl = document.getElementById('bar');
      if (timerEl) timerEl.textContent = '00:' + String(n).padStart(2, '0');
      if (barEl) barEl.style.width = (n / DEMO_SECONDS * 100) + '%';
      if (n >= DEMO_SECONDS) {
        clearInterval(t);
        const v = document.getElementById('st-visit');
        if (v) {
          v.textContent = 'Street visited';
          v.className = 'badge b-visited';
        }
        const confirmBtn = document.getElementById('confirm');
        if (confirmBtn) confirmBtn.disabled = false;
      }
    }, 1000);
  };
}

const confirmBtn = document.getElementById('confirm');
if (confirmBtn) {
  confirmBtn.onclick = function() {
    const c = document.getElementById('st-coll');
    if (c) {
      c.textContent = 'Collection confirmed';
      c.className = 'badge b-done';
    }
    this.disabled = true;
  };
}

// ------------------------------------------
// App Initialization
// ------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initMaps();
  startWorkerGpsTracking();
});
