// ═══════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════
let wifiPoints = [];
let map;
let markers = [];
let charts = {
    trend: null,
    places: null,
    altitudeInfo: null,
    altitudeTime: null
};
let currentMapLayer = null;
let currentUser = null; // { uid, name, email, photo }

const mapThemes = {
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    voyager: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    street: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    esri_street: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    topo: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
};

// ═══════════════════════════════════════════════════════════
//  Helpers & Custom Dialogs
// ═══════════════════════════════════════════════════════════
function customAlert(message) {
    return new Promise(resolve => {
        document.getElementById('dialog-title').innerText = 'Notice';
        document.getElementById('dialog-message').innerText = message;
        document.getElementById('dialog-input-container').classList.add('hidden');
        document.getElementById('dialog-btn-cancel').classList.add('hidden');
        const modal = document.getElementById('dialog-modal');
        const btnOk = document.getElementById('dialog-btn-confirm');
        const clickHandler = () => { btnOk.removeEventListener('click', clickHandler); modal.classList.add('hidden'); resolve(); };
        btnOk.addEventListener('click', clickHandler);
        modal.classList.remove('hidden');
    });
}

function customConfirm(message) {
    return new Promise(resolve => {
        document.getElementById('dialog-title').innerText = 'Confirm';
        document.getElementById('dialog-message').innerText = message;
        document.getElementById('dialog-input-container').classList.add('hidden');
        document.getElementById('dialog-btn-cancel').classList.remove('hidden');
        const modal = document.getElementById('dialog-modal');
        const btnOk = document.getElementById('dialog-btn-confirm');
        const btnCancel = document.getElementById('dialog-btn-cancel');
        const cleanup = () => { btnOk.removeEventListener('click', onOk); btnCancel.removeEventListener('click', onCancel); modal.classList.add('hidden'); };
        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };
        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        modal.classList.remove('hidden');
    });
}

function customPrompt(message, defaultVal = '') {
    return new Promise(resolve => {
        document.getElementById('dialog-title').innerText = 'Input';
        document.getElementById('dialog-message').innerText = message;
        document.getElementById('dialog-input-container').classList.remove('hidden');
        const input = document.getElementById('dialog-input');
        input.value = defaultVal;
        document.getElementById('dialog-btn-cancel').classList.remove('hidden');
        const modal = document.getElementById('dialog-modal');
        const btnOk = document.getElementById('dialog-btn-confirm');
        const btnCancel = document.getElementById('dialog-btn-cancel');
        const cleanup = () => { btnOk.removeEventListener('click', onOk); btnCancel.removeEventListener('click', onCancel); modal.classList.add('hidden'); };
        const onOk = () => { cleanup(); resolve(input.value); };
        const onCancel = () => { cleanup(); resolve(null); };
        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
        modal.classList.remove('hidden');
        setTimeout(() => input.focus(), 50);
    });
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// (measureSpeed removed in favor of instant geolocation altitude)

function showLoading(msg = 'Syncing with cloud…') {
    document.getElementById('loading-overlay').classList.remove('hidden');
    document.getElementById('loading-text').innerText = msg;
}
function hideLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════
//  Auth callbacks (called from MainActivity via JS bridge)
// ═══════════════════════════════════════════════════════════
window.onSignedIn = function (uid, name, email, photo) {
    currentUser = { uid, name, email, photo };
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
    document.getElementById('user-name').innerText = name;
    document.getElementById('user-email').innerText = email;
    if (photo) document.getElementById('user-avatar').src = photo;
    showLoading('Loading your map…');
    if (window.Android && window.Android.loadPoints) {
        window.Android.loadPoints();
    }
};

window.onSignedOut = function () {
    currentUser = null;
    wifiPoints = [];
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('main-app').classList.add('hidden');
    if (map) {
        markers.forEach(m => map.removeLayer(m));
        markers = [];
    }
    updateCharts();
};

window.onSignInError = function (code) {
    const el = document.getElementById('login-error');
    el.innerText = `Sign-in failed (${code}). Please try again.`;
    el.classList.remove('hidden');
};

// Called from Kotlin after loadPoints() fetches Firestore data
window.onPointsLoaded = function (jsonStr) {
    try {
        const arr = JSON.parse(jsonStr);
        wifiPoints = arr.map(p => {
            // Fix stringified history from older flawed Kotlin auto-tracks
            let safeHistory = p.history;
            if (typeof safeHistory === 'string') {
                try { safeHistory = JSON.parse(safeHistory); } catch (e) { safeHistory = []; }
            }
            if (!Array.isArray(safeHistory)) safeHistory = [];

            return {
                ...p,
                id: p.id,
                dateAdded: typeof p.dateAdded === 'object' ? Date.now() : Number(p.dateAdded),
                connections: Number(p.connections) || 1,
                history: safeHistory
            };
        });
    } catch (e) {
        wifiPoints = [];
    }
    hideLoading();
    renderMarkers();
    updateCharts();
    if (map) setTimeout(() => map.invalidateSize(), 150);
};

window.onPointSaved = function (firestoreId) {
    if (window._pendingSaveId && wifiPoints.find(p => p.id === window._pendingSaveId)) {
        wifiPoints.find(p => p.id === window._pendingSaveId).id = firestoreId;
        window._pendingSaveId = null;
    }
};

// ═══════════════════════════════════════════════════════════
//  Data persistence
// ═══════════════════════════════════════════════════════════
window.onImportReady = async function (jsonStr) {
    if (await customConfirm('Importing will merge new locations with your existing map. Continue?')) {
        try {
            const arr = JSON.parse(jsonStr);
            if (!Array.isArray(arr)) throw new Error("Invalid format");
            let importedCount = 0;
            arr.forEach(pt => {
                if (!pt.ssid || !pt.lat || !pt.lng) return;
                const exists = wifiPoints.some(p => p.id === pt.id || (p.ssid === pt.ssid && Math.abs(p.lat - pt.lat) < 0.0001 && Math.abs(p.lng - pt.lng) < 0.0001));
                if (!exists) {
                    pt.id = pt.id || String(Date.now() + Math.random());
                    wifiPoints.push(pt);
                    savePoint(pt);
                    importedCount++;
                }
            });
            renderMarkers();
            if (document.getElementById('stats-view').classList.contains('active')) updateCharts();
            await customAlert(`Successfully imported ${importedCount} new locations.`);
        } catch (e) {
            await customAlert("Failed to parse backup file. Please ensure it is a valid WiFiMapper JSON format.");
        }
    }
};

function savePoint(pt) {
    if (window.Android && window.Android.savePoint) {
        window.Android.savePoint(JSON.stringify(pt));
    }
}

function deletePoint(id) {
    if (window.Android && window.Android.deletePoint) {
        window.Android.deletePoint(String(id));
    }
}

// ═══════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    initSettings();
    initMap();
    initCharts();
    setupColorPickers();
    setupEventListeners();

    const isAndroid = /Android/i.test(navigator.userAgent);
    if (isAndroid && window.Android && window.Android.isSignedIn && window.Android.isSignedIn()) {
        const infoStr = window.Android.getUserInfo();
        if (infoStr) {
            try {
                const info = JSON.parse(infoStr);
                window.onSignedIn(info.uid, info.name, info.email, info.photo);
            } catch { showLoginScreen(); }
        } else { showLoginScreen(); }
    } else if (!isAndroid) {
        document.getElementById('login-overlay').classList.add('hidden');
        document.getElementById('main-app').classList.remove('hidden');
        document.getElementById('user-name').innerText = 'Preview Mode';
        wifiPoints = generateMockData();
        renderMarkers();
        updateCharts();
    } else {
        showLoginScreen();
    }
});

function showLoginScreen() {
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('main-app').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════
//  Mock data (browser preview only)
// ═══════════════════════════════════════════════════════════
const mockCities = [
    { city: "Kyiv", country: "Ukraine", lat: 50.4501, lng: 30.5234 },
    { city: "Lviv", country: "Ukraine", lat: 49.8397, lng: 24.0297 },
    { city: "Warsaw", country: "Poland", lat: 52.2297, lng: 21.0122 },
    { city: "Berlin", country: "Germany", lat: 52.5200, lng: 13.4050 },
    { city: "London", country: "UK", lat: 51.5074, lng: -0.1278 }
];

function generateMockData() {
    const points = [], now = new Date();
    const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
    for (let i = 0; i < 50; i++) {
        const c = mockCities[i % mockCities.length];
        points.push({
            id: `mock_${i}`,
            ssid: `WiFi_${c.city}_${i}`,
            lat: c.lat + (Math.random() * 0.1 - 0.05),
            lng: c.lng + (Math.random() * 0.1 - 0.05),
            city: c.city, country: c.country,
            speed: undefined, // deprecated
            altitude: Math.floor(Math.random() * 500),
            note: 'Mock point', connections: Math.floor(Math.random() * 5) + 1,
            markerColor: colors[Math.floor(Math.random() * colors.length)],
            dateAdded: new Date(now - Math.random() * 365 * 86400000).getTime()
        });
    }
    return points;
}

// ═══════════════════════════════════════════════════════════
//  Settings
// ═══════════════════════════════════════════════════════════
function applyChartFont(size) {
    if (window.Chart) {
        const px = parseInt(size.replace('px', '')) || 14;
        Chart.defaults.font.size = Math.max(6, px - 2); // Support much smaller fonts
        if (typeof charts !== 'undefined' && charts.trend) updateCharts();
    }
}

function initSettings() {
    const appTheme = localStorage.getItem('appTheme') || 'dark';
    if (appTheme === 'light') document.body.classList.add('light-theme');
    document.getElementById('app-theme-select').value = appTheme;

    const fontSize = localStorage.getItem('appFontSize') || '14px';
    document.documentElement.style.setProperty('--app-font-size', fontSize);
    document.querySelectorAll('.font-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-size') === fontSize);
    });
    applyChartFont(fontSize);

    const markerSize = localStorage.getItem('markerSize') || '1.0';
    document.querySelectorAll('.marker-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-size') === markerSize);
    });

    const isPublic = localStorage.getItem('isPublicProfile') === 'true';
    const publicToggle = document.getElementById('public-map-toggle');
    if (publicToggle) publicToggle.checked = isPublic;

    // Auto-track: read from Android native prefs if available, else localStorage
    const autoTrackToggle = document.getElementById('auto-track-toggle');
    if (autoTrackToggle) {
        const isAutoTrack = window.Android && window.Android.isAutoTrackEnabled
            ? window.Android.isAutoTrackEnabled()
            : localStorage.getItem('autoTrackEnabled') === 'true';
        autoTrackToggle.checked = isAutoTrack;
    }

    const silentTrackToggle = document.getElementById('silent-track-toggle');
    if (silentTrackToggle) {
        silentTrackToggle.checked = localStorage.getItem('silentTrackEnabled') === 'true';
    }

    const cooldownSelect = document.getElementById('auto-track-cooldown-select');
    if (cooldownSelect) {
        const cooldown = localStorage.getItem('autoTrackCooldown') || '60';
        cooldownSelect.value = cooldown;
        const infoText = document.getElementById('info-cooldown-text');
        if (infoText) {
            if (cooldown == 60) infoText.innerText = '1 hour';
            else if (cooldown == 360) infoText.innerText = '6 hours';
            else if (cooldown == 720) infoText.innerText = '12 hours';
            else if (cooldown == 1440) infoText.innerText = '24 hours';
            else infoText.innerText = `${cooldown} minutes`;
        }

        cooldownSelect.addEventListener('change', e => {
            const val = e.target.value;
            localStorage.setItem('autoTrackCooldown', val);
            const t = document.getElementById('info-cooldown-text');
            if (t) {
                if (val == 60) t.innerText = '1 hour';
                else if (val == 360) t.innerText = '6 hours';
                else if (val == 720) t.innerText = '12 hours';
                else if (val == 1440) t.innerText = '24 hours';
                else t.innerText = `${val} minutes`;
            }
            if (window.Android && window.Android.setAutoTrackCooldown) {
                window.Android.setAutoTrackCooldown(parseInt(val, 10));
            }
        });
    }

    document.getElementById('map-theme-select').value = localStorage.getItem('mapTheme') || 'dark';

    const densitySelect = document.getElementById('cluster-density-select');
    if (densitySelect) {
        densitySelect.value = localStorage.getItem('clusterDensity') || '40';
        densitySelect.addEventListener('change', e => {
            localStorage.setItem('clusterDensity', e.target.value);
            renderMarkers();
        });
    }
}

// ═══════════════════════════════════════════════════════════
//  Color Picker helpers
// ═══════════════════════════════════════════════════════════
function setupColorPickers() {
    document.querySelectorAll('.color-picker').forEach(picker => {
        picker.addEventListener('click', e => {
            if (e.target.classList.contains('color-option')) {
                picker.querySelectorAll('.color-option').forEach(o => o.classList.remove('active'));
                e.target.classList.add('active');
            }
        });
    });
}
function getColor(pickerId) {
    const a = document.querySelector(`#${pickerId} .color-option.active`);
    return a ? a.getAttribute('data-color') : '#3b82f6';
}
function setColor(pickerId, color) {
    const picker = document.getElementById(pickerId);
    if (!picker) return;
    picker.querySelectorAll('.color-option').forEach(o => o.classList.remove('active'));
    const opt = picker.querySelector(`.color-option[data-color="${color}"]`);
    if (opt) opt.classList.add('active');
    else if (picker.firstElementChild) picker.firstElementChild.classList.add('active');
}

// ═══════════════════════════════════════════════════════════
//  Event Listeners
// ═══════════════════════════════════════════════════════════
function setupEventListeners() {
    document.getElementById('google-signin-btn').addEventListener('click', () => {
        const isAndroid = /Android/i.test(navigator.userAgent);
        if (isAndroid && window.Android && window.Android.signInWithGoogle) {
            window.Android.signInWithGoogle();
        }
    });

    document.getElementById('signout-btn').addEventListener('click', async () => {
        if (await customConfirm('Sign out of your account?')) {
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isAndroid && window.Android && window.Android.signOut) {
                window.Android.signOut();
            } else {
                window.onSignedOut();
            }
        }
    });

    document.getElementById('app-theme-select').addEventListener('change', e => {
        document.body.classList.toggle('light-theme', e.target.value === 'light');
        localStorage.setItem('appTheme', e.target.value);
    });

    document.querySelectorAll('.font-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            const size = e.target.getAttribute('data-size');
            document.querySelectorAll('.font-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            document.documentElement.style.setProperty('--app-font-size', size);
            localStorage.setItem('appFontSize', size);
            applyChartFont(size);
        });
    });



    document.querySelectorAll('.marker-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            const size = e.target.getAttribute('data-size');
            document.querySelectorAll('.marker-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            localStorage.setItem('markerSize', size);
            renderMarkers();
        });
    });

    document.getElementById('map-theme-select').addEventListener('change', e => {
        setMapTheme(e.target.value);
        localStorage.setItem('mapTheme', e.target.value);
        setTimeout(() => map.invalidateSize(), 150);
    });

    const publicToggle = document.getElementById('public-map-toggle');
    if (publicToggle) {
        publicToggle.addEventListener('change', e => {
            const isPublic = e.target.checked;
            localStorage.setItem('isPublicProfile', isPublic);
            if (window.Android && window.Android.setPublicProfile) {
                window.Android.setPublicProfile(isPublic);
            }
        });
    }

    const autoTrackToggle = document.getElementById('auto-track-toggle');
    if (autoTrackToggle) {
        autoTrackToggle.addEventListener('change', async e => {
            const enabled = e.target.checked;
            localStorage.setItem('autoTrackEnabled', enabled);
            if (window.Android && window.Android.setAutoTrack) {
                window.Android.setAutoTrack(enabled);
                if (enabled) {
                    await customAlert('Auto-Track is ON! ⚡\n\nThe app will automatically log your location whenever you connect to a new Wi-Fi network — even when the app is in the background.');
                } else {
                    await customAlert('Auto-Track is OFF. Networks will only be registered manually.');
                }
            } else {
                await customAlert('Auto-Track is only available on the Android app.');
                e.target.checked = false;
            }
        });
    }

    const silentTrackToggle = document.getElementById('silent-track-toggle');
    if (silentTrackToggle) {
        silentTrackToggle.addEventListener('change', e => {
            const enabled = e.target.checked;
            localStorage.setItem('silentTrackEnabled', enabled);
            if (window.Android && window.Android.setSilentTrack) {
                window.Android.setSilentTrack(enabled);
            }
        });
    }

    document.getElementById('clear-data-btn').addEventListener('click', async () => {
        if (await customConfirm('Delete ALL saved networks permanently?')) {
            wifiPoints = [];
            if (window.Android && window.Android.deleteAllPoints) window.Android.deleteAllPoints();
            renderMarkers();
            updateCharts();
            await customAlert('All data cleared.');
        }
    });

    document.getElementById('export-data-btn').addEventListener('click', async () => {
        if (!wifiPoints.length) { await customAlert("No points to export!"); return; }
        if (window.Android && window.Android.exportData) {
            window.Android.exportData(JSON.stringify(wifiPoints));
        } else {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(wifiPoints));
            const dl = document.createElement('a');
            dl.setAttribute("href", dataStr);
            dl.setAttribute("download", "WiFiMapper_Backup.json");
            dl.click();
        }
    });

    document.getElementById('import-data-btn').addEventListener('click', async () => {
        if (window.Android && window.Android.importData) {
            window.Android.importData();
        } else {
            await customAlert("File import is only supported inside the Android App.");
        }
    });

    document.querySelectorAll('.nav-links li').forEach(li => {
        li.addEventListener('click', e => {
            document.querySelectorAll('.nav-links li').forEach(el => el.classList.remove('active'));
            e.currentTarget.classList.add('active');
            const targetId = e.currentTarget.getAttribute('data-target');
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById(targetId).classList.add('active');
            if (targetId === 'map-view') setTimeout(() => map.invalidateSize(), 150);
            else if (targetId === 'stats-view') updateCharts();
        });
    });

    // ── Register button ───────────────────────────────────────────────────
    const regBtn = document.getElementById('register-btn');
    regBtn.addEventListener('click', async () => {
        if (!navigator.geolocation) { await customAlert('Geolocation not supported'); return; }
        const orig = regBtn.innerText;
        regBtn.innerText = 'Detecting…';
        regBtn.disabled = true;

        const resetRegBtn = () => { regBtn.innerText = orig; regBtn.disabled = false; };

        try {
            let defaultName = 'Unknown Wi-Fi', ipLat = null, ipLng = null;
            try {
                const ipData = await (await fetch('http://ip-api.com/json/')).json();
                if (ipData.status === 'success') {
                    if (ipData.isp) defaultName = ipData.isp;
                    ipLat = ipData.lat; ipLng = ipData.lon;
                }
            } catch { }

            let detectedSSID = '';
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isAndroid && window.Android && window.Android.getSSID) {
                const s = window.Android.getSSID();
                if (!s || s.includes('<unknown ssid>') || s === '0x' || s.trim() === '') {
                    await customAlert('No available wifi network. Please connect to a Wi-Fi or turn on location services.');
                    resetRegBtn(); return;
                }
                detectedSSID = s.replace(/"/g, '');
            } else {
                if (!navigator.onLine) {
                    await customAlert('No available wifi network. You are offline.');
                    resetRegBtn(); return;
                }
                detectedSSID = defaultName;
            }
            detectedSSID = detectedSSID.trim();

            const detectedReliability = Math.floor(Math.random() * 20) + 80;

            const processLocation = async (lat, lng, altitude = 0) => {
                let city = 'Unknown', country = 'Unknown';
                try {
                    // Enforce English localization for all reverse geocoding
                    const d = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=en`)).json();
                    city = d.address?.city || d.address?.town || d.address?.village || 'Unknown';
                    country = d.address?.country || 'Unknown country';
                } catch { }

                let duplicate = null;
                for (const pt of wifiPoints) {
                    if (pt.ssid === detectedSSID && getDistance(pt.lat, pt.lng, lat, lng) <= 150) {
                        duplicate = pt; break;
                    }
                }

                if (duplicate) {
                    if (!duplicate.history) duplicate.history = [];
                    window._pendingDuplicateHistoryObj = { date: Date.now(), altitude: Math.round(altitude), note: '' };
                    duplicate.history.push(window._pendingDuplicateHistoryObj);
                    duplicate.connections += 1;
                    savePoint(duplicate);
                    renderMarkers();
                    if (document.getElementById('stats-view').classList.contains('active')) updateCharts();
                    map.setView([lat, lng], 14);
                    resetRegBtn();
                    window.openEditModal(duplicate.id);
                    document.getElementById('edit-wifi-note').value = ''; // Ensure the note is empty by default
                    return;
                }

                document.getElementById('reg-wifi-name').value = detectedSSID;
                document.getElementById('reg-wifi-altitude').value = Math.round(altitude);
                document.getElementById('reg-wifi-note').value = '';
                setColor('reg-color-picker', '#14b8a6');
                document.getElementById('reg-location-info').innerText = `📍 ${city}, ${country}`;
                window.pendingNewPoint = { id: String(Date.now()), lat, lng, city, country, dateAdded: Date.now() };
                document.getElementById('registration-modal').classList.remove('hidden');
                resetRegBtn();
            };

            const attemptGeo = () => {
                navigator.geolocation.getCurrentPosition(
                    pos => processLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.altitude || 0),
                    async err => {
                        let reason = err.code === 1 ? 'Permission denied.' : err.code === 2 ? 'GPS unavailable.' : 'Timeout.';
                        if (!window.isSecureContext) reason = 'HTTPS required for geolocation.';
                        document.getElementById('geo-modal-desc').innerHTML = `Enable geolocation.<br><span style="color:#f87171;font-size:.9em"><b>Reason:</b> ${reason}</span>`;
                        document.getElementById('geo-modal').classList.remove('hidden');
                        window.pendingGeoRetry = attemptGeo;
                        window.pendingGeoCancel = resetRegBtn;
                        window.pendingGeoIP = async () => {
                            if (ipLat && ipLng) processLocation(ipLat, ipLng, 0);
                            else { await customAlert('Cannot get coordinates via IP.'); resetRegBtn(); }
                        };
                    },
                    { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
                );
            };
            attemptGeo();
        } catch (error) {
            console.error(error);
            await customAlert("An error occurred during detection.");
            resetRegBtn();
        }
    });

    // Refresh Map Data Button
    document.getElementById('refresh-map-btn').addEventListener('click', () => {
        showLoading('Refreshing data…');
        if (window.Android && window.Android.loadPoints) {
            window.Android.loadPoints();
        } else {
            // Fallback for preview mode
            setTimeout(() => { hideLoading(); renderMarkers(); updateCharts(); }, 600);
        }
    });

    const myLocBtn = document.getElementById('my-location-btn');
    if (myLocBtn) {
        myLocBtn.addEventListener('click', () => {
            if (!map) return;
            if (window.myLocationMarker) {
                map.removeLayer(window.myLocationMarker);
                window.myLocationMarker = null;
            } else {
                showLoading('Locating…');
                map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true });
            }
        });
    }

    if (map) {
        map.on('locationfound', e => {
            hideLoading();
            if (window.myLocationMarker) map.removeLayer(window.myLocationMarker);
            window.myLocationMarker = L.circleMarker(e.latlng, {
                radius: 8, fillColor: '#3b82f6', color: '#ffffff', weight: 2, opacity: 1, fillOpacity: 0.9
            }).addTo(map);
        });
        map.on('locationerror', e => {
            hideLoading();
            customAlert("Could not find your location. Please ensure location services are enabled.");
        });
    }

    // Geo modal
    document.getElementById('geo-modal-cancel').addEventListener('click', () => {
        document.getElementById('geo-modal').classList.add('hidden');
        if (window.pendingGeoCancel) window.pendingGeoCancel();
    });
    document.getElementById('geo-modal-retry').addEventListener('click', () => {
        document.getElementById('geo-modal').classList.add('hidden');
        if (window.pendingGeoRetry) window.pendingGeoRetry();
    });
    document.getElementById('geo-modal-ip-fallback').addEventListener('click', () => {
        document.getElementById('geo-modal').classList.add('hidden');
        if (window.pendingGeoIP) window.pendingGeoIP();
    });

    // Registration modal
    document.getElementById('reg-modal-cancel').addEventListener('click', () => {
        document.getElementById('registration-modal').classList.add('hidden');
        const btn = document.getElementById('register-btn');
        btn.innerText = 'Register network'; btn.disabled = false;
    });

    document.getElementById('reg-form').addEventListener('submit', async e => {
        e.preventDefault();
        const pt = window.pendingNewPoint;
        if (!pt) return;
        pt.ssid = document.getElementById('reg-wifi-name').value.trim();
        const altVal = document.getElementById('reg-wifi-altitude').value;
        pt.altitude = altVal ? Math.round(parseFloat(altVal)) : 0;
        pt.markerColor = getColor('reg-color-picker');
        pt.note = document.getElementById('reg-wifi-note').value.trim();
        pt.connections = 1;
        wifiPoints.push(pt);
        savePoint(pt);
        renderMarkers();
        if (document.getElementById('stats-view').classList.contains('active')) updateCharts();
        map.setView([pt.lat, pt.lng], 14);
        document.getElementById('registration-modal').classList.add('hidden');
        await customAlert(`Saved: "${pt.ssid}"`);
        const btn = document.getElementById('register-btn');
        btn.innerText = 'Register network'; btn.disabled = false;
    });

    // Edit modal
    document.getElementById('edit-modal-cancel').addEventListener('click', () => {
        document.getElementById('edit-modal').classList.add('hidden');
        window._pendingDuplicateHistoryObj = null;
    });

    document.getElementById('edit-form').addEventListener('submit', e => {
        e.preventDefault();
        const id = document.getElementById('edit-wifi-id').value;
        const point = wifiPoints.find(p => String(p.id) === String(id));
        if (point) {
            point.ssid = document.getElementById('edit-wifi-name').value.trim();
            const altVal = document.getElementById('edit-wifi-altitude').value;
            if (altVal !== '') point.altitude = Math.round(parseFloat(altVal));
            point.note = document.getElementById('edit-wifi-note').value.trim();

            if (window._pendingDuplicateHistoryObj) {
                window._pendingDuplicateHistoryObj.note = point.note;
                window._pendingDuplicateHistoryObj = null;
            }

            point.markerColor = getColor('edit-color-picker');
            savePoint(point);
            renderMarkers();
            document.getElementById('edit-modal').classList.add('hidden');
            if (document.getElementById('stats-view').classList.contains('active')) updateCharts();
        }
    });

    document.getElementById('edit-modal-delete').addEventListener('click', async () => {
        const id = document.getElementById('edit-wifi-id').value;
        if (await customConfirm('Delete this network?')) {
            wifiPoints = wifiPoints.filter(p => String(p.id) !== String(id));
            deletePoint(id);
            renderMarkers();
            document.getElementById('edit-modal').classList.add('hidden');
            if (document.getElementById('stats-view').classList.contains('active')) updateCharts();
        }
    });
}

// ═══════════════════════════════════════════════════════════
//  Map
// ═══════════════════════════════════════════════════════════
function initMap() {
    map = L.map('map', {
        attributionControl: false,
        preferCanvas: true,
        wheelPxPerZoomLevel: 60, // Smoother trackpad zoom
        zoomDelta: 0.5,          // Half-step zooms
        zoomSnap: 0.5,           // Allow stopping at half zooms
        fadeAnimation: true,
        markerZoomAnimation: true,
        bounceAtZoomLimits: false
    }).setView([48.0, 31.0], 4);
    setMapTheme(localStorage.getItem('mapTheme') || 'dark');
}

function setMapTheme(key) {
    if (currentMapLayer) map.removeLayer(currentMapLayer);
    currentMapLayer = L.tileLayer(mapThemes[key] || mapThemes.dark, {
        attribution: '&copy; Leaflet contributors',
        subdomains: 'abcd',
        maxZoom: 20,
        maxNativeZoom: 19,
        keepBuffer: 8,           // Keep more buffer tiles off-screen
        updateWhenZooming: true, // Fetch new tiles DURING zoom (stops white squares)
        updateWhenIdle: false,   // Start fetching before movement fully stops
        updateInterval: 50,      // Fetch 4 times faster than default (50ms)
        crossOrigin: true        // Hardware decoding enabled
    }).addTo(map);
}

let markerClusterGroup = null;

function renderMarkers() {
    if (markerClusterGroup) {
        map.removeLayer(markerClusterGroup);
    }

    // Cluster markers to massively improve zoom out performance
    const density = parseInt(localStorage.getItem('clusterDensity') || '40', 10);

    if (density > 0) {
        markerClusterGroup = L.markerClusterGroup({
            maxClusterRadius: density,
            disableClusteringAtZoom: 15, // Expand to individual pins when zoomed in closely
            spiderfyOnMaxZoom: true,
            showCoverageOnHover: false,
            chunkedLoading: true // Renders pins in chunks to prevent UI freeze
        });
    } else {
        markerClusterGroup = L.featureGroup();
    }

    markers = [];

    const scale = parseFloat(localStorage.getItem('markerSize') || '1.0');
    const w = 30 * scale;
    const h = 42 * scale;

    wifiPoints.forEach(pt => {
        let mColor = pt.markerColor || '#14b8a6';
        if (!pt.markerColor && pt.connections > 10) mColor = '#3b82f6';
        if (!pt.markerColor && pt.connections > 50) mColor = '#8b5cf6';

        const icon = L.divIcon({
            className: 'custom-pin',
            iconAnchor: [w / 2, h], popupAnchor: [0, -h],
            html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 42" width="${w}" height="${h}">
                <path fill="${mColor}" d="M15 0C6.716 0 0 6.716 0 15c0 10.5 15 27 15 27s15-16.5 15-27c0-8.284-6.716-15-15-15z"/>
                <circle fill="#ffffff" cx="15" cy="15" r="7"/>
            </svg>`
        });
        const dateStr = new Date(pt.dateAdded).toLocaleDateString('en-US');
        const altStr = pt.altitude !== undefined && pt.altitude !== null ? pt.altitude : '0';
        const popup = `<div class="custom-popup">
            <b style="color:${mColor}">${pt.ssid}</b>
            <p>📍 ${pt.city}, ${pt.country}</p>
            <p>📅 Added: ${dateStr}</p>
            <p>🏔️ Altitude: ${altStr} m</p>
            <p>🔗 Connections: ${pt.connections}</p>
            <p>📝 Note: ${pt.note || 'None'}</p>
            <div style="display:flex;gap:8px;margin-top:8px;">
                <button class="popup-btn" style="flex:1;background:rgba(255,255,255,0.1);color:#fff" onclick="window.viewHistory('${pt.id}')">History</button>
                <button class="popup-btn" style="flex:1;background:${mColor};color:#fff" onclick="window.openEditModal('${pt.id}')">Edit</button>
            </div>
        </div>`;
        const marker = L.marker([pt.lat, pt.lng], { icon }).bindPopup(popup, { minWidth: 220 });
        markerClusterGroup.addLayer(marker);
        markers.push(marker);
    });

    markerClusterGroup.addTo(map);
}

window.viewHistory = function (id) {
    const pt = wifiPoints.find(p => String(p.id) === String(id));
    if (!pt) return;
    map.closePopup();

    let histHtml = `<div style="text-align:left; max-height:350px; overflow-y:auto; padding-right:4px;">`;

    const altStr = pt.altitude !== undefined && pt.altitude !== null ? pt.altitude : '0';
    histHtml += `
        <div style="background:rgba(255,255,255,0.03); border-radius:8px; border:1px solid rgba(255,255,255,0.05); padding:10px; margin-bottom:8px;">
            <div style="color:var(--teal); font-weight:700; font-size:0.85rem; margin-bottom:4px; display:flex; justify-content:space-between;">
                <span>#1</span>
                <span style="color:var(--slate-light); font-weight:500; font-size:0.8rem;">${new Date(Number(pt.dateAdded)).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div style="color:var(--slate-light); font-size:0.8rem;">Alt: ${altStr}m</div>
            ${pt.note ? `<div style="color:var(--text-main); font-size:0.8rem; margin-top:4px;">${pt.note}</div>` : ''}
        </div>
    `;

    if (pt.history && pt.history.length > 0) {
        pt.history.forEach((h, i) => {
            const hAlt = h.altitude !== undefined && h.altitude !== null ? h.altitude : '0';
            histHtml += `
                <div style="background:rgba(255,255,255,0.03); border-radius:8px; border:1px solid rgba(255,255,255,0.05); padding:10px; margin-bottom:8px;">
                    <div style="color:var(--teal); font-weight:700; font-size:0.85rem; margin-bottom:4px; display:flex; justify-content:space-between;">
                        <span>#${i + 2} ${h.auto ? '⚡' : ''}</span>
                        <span style="color:var(--slate-light); font-weight:500; font-size:0.8rem;">${new Date(Number(h.date)).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <div style="color:var(--slate-light); font-size:0.8rem;">Alt: ${hAlt}m</div>
                    ${h.note ? `<div style="color:var(--text-main); font-size:0.8rem; margin-top:4px;">${h.note}</div>` : ''}
                </div>
            `;
        });
    }
    histHtml += `</div>`;

    document.getElementById('dialog-title').innerText = 'Network History';
    document.getElementById('dialog-message').innerHTML = histHtml;
    document.getElementById('dialog-input-container').classList.add('hidden');
    document.getElementById('dialog-btn-cancel').classList.add('hidden');
    const modal = document.getElementById('dialog-modal');
    const btnOk = document.getElementById('dialog-btn-confirm');
    const clickHandler = () => {
        btnOk.removeEventListener('click', clickHandler);
        modal.classList.add('hidden');
        document.getElementById('dialog-message').innerHTML = '';
    };
    btnOk.addEventListener('click', clickHandler);
    modal.classList.remove('hidden');
};

window.openEditModal = function (id) {
    const point = wifiPoints.find(p => String(p.id) === String(id));
    if (!point) return;
    document.getElementById('edit-wifi-id').value = id;
    document.getElementById('edit-wifi-name').value = point.ssid;
    document.getElementById('edit-wifi-altitude').value = point.altitude !== undefined ? Math.round(point.altitude) : '';
    document.getElementById('edit-wifi-note').value = point.note || '';
    setColor('edit-color-picker', point.markerColor || '#3b82f6');
    document.getElementById('edit-location-info').innerText =
        `📍 ${point.city}, ${point.country} | Connections: ${point.connections}`;
    map.closePopup();
    document.getElementById('edit-modal').classList.remove('hidden');
};

// ═══════════════════════════════════════════════════════════
//  Charts
// ═══════════════════════════════════════════════════════════
function initCharts() {
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = 'Inter';
    if (charts.trend) charts.trend.destroy();
    if (charts.total) charts.total.destroy();
    if (charts.altitudeInfo) charts.altitudeInfo.destroy();
    if (charts.places) charts.places.destroy();

    charts.trend = new Chart(document.getElementById('trendChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [] },
        options: { responsive: true, tension: 0.3, plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
    charts.altitudeInfo = new Chart(document.getElementById('altitudeHistogramChart').getContext('2d'), {
        type: 'bar', data: { labels: [], datasets: [] },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: 'Count' } }, x: { title: { display: true, text: 'Altitude Ranges (m)' } } } }
    });

    document.querySelectorAll('#trend-group-filters .chart-filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('#trend-group-filters .chart-filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            window._trendGroup = e.target.getAttribute('data-group');
            updateTrendChart();
        });
    });
    charts.places = new Chart(document.getElementById('placesChart').getContext('2d'), {
        type: 'bar', data: { labels: [], datasets: [] },
        options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
    });

    if (charts.altitudeTime) charts.altitudeTime.destroy();
    charts.altitudeTime = new Chart(document.getElementById('altitudeTimeChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [] },
        options: {
            responsive: true, maintainAspectRatio: false, tension: 0.3,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            const c = window._filteredAltConnections ? window._filteredAltConnections[context.dataIndex] : null;
                            if (c) {
                                return [
                                    `Altitude: ${c.altitude}m`,
                                    `SSID: ${c.ssid || 'Unknown'}`,
                                    `Loc: ${c.city || 'Unknown'}`
                                ];
                            }
                            return `Altitude: ${context.parsed.y}m`;
                        }
                    }
                }
            },
            scales: { y: { beginAtZero: false, title: { display: true, text: 'Altitude (m)' } } }
        }
    });

    document.querySelectorAll('#alt-time-filters .chart-filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('#alt-time-filters .chart-filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            window._currentAltRange = e.target.getAttribute('data-range');
            updateAltitudeTimeChart();
        });
    });

    document.querySelectorAll('#timeline-filters .chart-filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('#timeline-filters .chart-filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            window._timelineRange = e.target.getAttribute('data-range');
            updateTimeline();
        });
    });

    const locSelect = document.getElementById('locations-count-select');
    if (locSelect) locSelect.addEventListener('change', populateTables);

    const connSelect = document.getElementById('connections-count-select');
    if (connSelect) connSelect.addEventListener('change', populateTables);
}

function updateCharts() {
    buildGlobalConnections();

    const totalConnections = wifiPoints.reduce((s, p) => s + p.connections, 0);
    document.getElementById('total-connections-val').innerText = totalConnections;
    document.getElementById('unique-connections-val').innerText = wifiPoints.length;

    updateTrendChart();
    updateTimeline();
    updateAltitudeTimeChart();

    // Altitude Statistics
    let altitudes = wifiPoints.map(p => p.altitude || 0).filter(a => typeof a === 'number');
    if (altitudes.length > 0) {
        altitudes.sort((a, b) => a - b);
        const min = Math.round(altitudes[0]);
        const max = Math.round(altitudes[altitudes.length - 1]);
        const avg = Math.round(altitudes.reduce((a, b) => a + b, 0) / altitudes.length);
        const median = altitudes.length % 2 === 0 ? (altitudes[altitudes.length / 2 - 1] + altitudes[altitudes.length / 2]) / 2 : altitudes[Math.floor(altitudes.length / 2)];
        document.getElementById('alt-min-val').innerText = min + 'm';
        document.getElementById('alt-max-val').innerText = max + 'm';
        document.getElementById('alt-avg-val').innerText = avg + 'm';
        document.getElementById('alt-median-val').innerText = Math.round(median) + 'm';

        // Build DYNAMIC Histogram — bins auto-scale to actual altitude range
        const BINS = 6;
        const binMin = Math.max(0, Math.floor(min / 10) * 10);
        const binMax = Math.max(binMin + BINS * 10, Math.ceil(max / 10) * 10 + 10);
        const step = Math.ceil((binMax - binMin) / BINS);
        const bins = [], counts = [];
        for (let i = 0; i < BINS; i++) {
            const lo = binMin + i * step;
            const hi = binMin + (i + 1) * step;
            bins.push(`${lo}-${hi}m`);
            counts.push(altitudes.filter(a => a >= lo && a < hi).length);
        }
        // Merge empty trailing bins
        let lastNonEmpty = counts.length - 1;
        while (lastNonEmpty > 0 && counts[lastNonEmpty] === 0) lastNonEmpty--;
        const trimmedBins = bins.slice(0, lastNonEmpty + 1);
        const trimmedCounts = counts.slice(0, lastNonEmpty + 1);
        charts.altitudeInfo.data = {
            labels: trimmedBins,
            datasets: [{ data: trimmedCounts, backgroundColor: '#3b82f6', borderRadius: 4 }]
        };
        charts.altitudeInfo.update();
    } else {
        document.getElementById('alt-min-val').innerText = '0m';
        document.getElementById('alt-max-val').innerText = '0m';
        document.getElementById('alt-avg-val').innerText = '0m';
        document.getElementById('alt-median-val').innerText = '0m';
        charts.altitudeInfo.data = { labels: ['No Data'], datasets: [{ data: [0] }] };
        charts.altitudeInfo.update();
    }

    // Top Locations — show UNIQUE networks per city (count of wifiPoints per city)
    const cityUnique = {};
    wifiPoints.forEach(p => { const k = `${p.city}, ${p.country}`; cityUnique[k] = (cityUnique[k] || 0) + 1; });
    const top5 = Object.entries(cityUnique).sort((a, b) => b[1] - a[1]).slice(0, 5);
    charts.places.data = {
        labels: top5.length ? top5.map(c => c[0]) : ['No data'],
        datasets: [{ label: 'Unique Networks', data: top5.map(c => c[1]), backgroundColor: '#0f766e', borderRadius: 4 }]
    };
    charts.places.update();

    populateTables();
}

function populateTables() {
    // LOCATIONS TABLE
    const locSelect = document.getElementById('locations-count-select');
    const locLimit = locSelect ? parseInt(locSelect.value) : 10;
    const locTbody = document.getElementById('recent-locations-tbody');
    if (locTbody) {
        locTbody.innerHTML = '';
        const sortedPoints = [...wifiPoints].sort((a, b) => Number(b.dateAdded) - Number(a.dateAdded)).slice(0, locLimit);
        if (sortedPoints.length === 0) {
            locTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--slate-light);">No locations recorded yet.</td></tr>';
        } else {
            sortedPoints.forEach(pt => {
                const tr = document.createElement('tr');
                const dStr = new Date(Number(pt.dateAdded)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const alt = pt.altitude !== undefined && pt.altitude !== null ? Math.round(pt.altitude) : 0;
                const loc = `${pt.city || '?'}, ${pt.country || '?'}`;
                const ssid = pt.ssid || '';
                tr.innerHTML = `
                    <td style="padding:8px 5px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:0.75rem; color:var(--slate-light); word-break:break-word;">${dStr}</td>
                    <td style="padding:8px 5px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:0.78rem; word-wrap:break-word;" title="${loc}">${loc}</td>
                    <td style="padding:8px 5px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:0.78rem; font-weight:600; color:var(--teal); word-wrap:break-word;" title="${ssid}">${ssid}</td>
                    <td style="padding:8px 2px; border-bottom:1px solid rgba(255,255,255,0.04); text-align:right; white-space:nowrap; font-weight:600; color:#94a3b8; font-size:0.78rem;">${alt}m</td>
                `;
                locTbody.appendChild(tr);
            });
        }
    }

    // CONNECTIONS TABLE
    const connSelect = document.getElementById('connections-count-select');
    const connLimit = connSelect ? parseInt(connSelect.value) : 10;
    const connTbody = document.getElementById('recent-connections-tbody');
    if (connTbody) {
        connTbody.innerHTML = '';
        if (!window._allConnections) buildGlobalConnections();
        const sortedConns = [...window._allConnections].sort((a, b) => b.date - a.date).slice(0, connLimit);
        if (sortedConns.length === 0) {
            connTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--slate-light);">No connections recorded yet.</td></tr>';
        } else {
            sortedConns.forEach(conn => {
                const tr = document.createElement('tr');
                const dStr = new Date(conn.date).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const alt = conn.altitude !== undefined && conn.altitude !== null ? Math.round(conn.altitude) : 0;
                const loc = `${conn.city || '?'}, ${conn.country || '?'}`;
                const ssid = conn.ssid || '';
                tr.innerHTML = `
                    <td style="padding:8px 5px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:0.75rem; color:var(--slate-light); word-break:break-word;">${dStr}</td>
                    <td style="padding:8px 5px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:0.78rem; word-wrap:break-word;" title="${loc}">${loc}</td>
                    <td style="padding:8px 5px; border-bottom:1px solid rgba(255,255,255,0.04); font-size:0.78rem; font-weight:600; color:var(--teal); word-wrap:break-word;" title="${ssid}">${ssid}</td>
                    <td style="padding:8px 2px; border-bottom:1px solid rgba(255,255,255,0.04); text-align:right; white-space:nowrap; font-weight:600; color:#94a3b8; font-size:0.78rem;">${alt}m</td>
                `;
                connTbody.appendChild(tr);
            });
        }
    }

    // Since timeline and altitude also need global connections:
    buildGlobalConnections();
    updateTimeline();
    updateAltitudeTimeChart();
}
function updateTrendChart() {
    if (!charts.trend) return;
    const trendTotal = {}, trendUnique = {};
    const groupType = window._trendGroup || 'month';

    const getGroupKey = (timestamp) => {
        const d = new Date(timestamp);
        if (groupType === 'day') {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        } else if (groupType === 'week') {
            const firstJan = new Date(d.getFullYear(), 0, 1);
            const days = Math.floor((d - firstJan) / 86400000);
            const weekNum = Math.ceil((days + firstJan.getDay() + 1) / 7);
            return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        } else {
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        }
    };

    wifiPoints.forEach(pt => {
        const k = getGroupKey(Number(pt.dateAdded));
        trendUnique[k] = (trendUnique[k] || 0) + 1;
    });

    if (!window._allConnections) buildGlobalConnections();
    window._allConnections.forEach(conn => {
        const k = getGroupKey(conn.date);
        trendTotal[k] = (trendTotal[k] || 0) + 1;
    });

    const keySet = new Set([...Object.keys(trendUnique), ...Object.keys(trendTotal)]);
    const keys = Array.from(keySet).sort();

    charts.trend.data = {
        labels: keys.length ? keys : ['No data'],
        datasets: [
            { label: 'Total Connections', data: keys.map(k => trendTotal[k] || 0), borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,.1)', fill: true, pointBackgroundColor: '#6366f1', pointRadius: 4, tension: 0.4 },
            { label: 'New Networks', data: keys.map(k => trendUnique[k] || 0), borderColor: '#14b8a6', backgroundColor: 'rgba(20,184,166,.2)', fill: true, pointBackgroundColor: '#14b8a6', pointRadius: 4, tension: 0.4 }
        ]
    };
    charts.trend.options.plugins.legend.labels = { color: Chart.defaults.color };
    charts.trend.update();
}

function buildGlobalConnections() {
    let connections = [];
    wifiPoints.forEach(pt => {
        // All events for this point, newest first
        const allForPt = [
            { date: Number(pt.dateAdded), note: pt.note || '', altitude: pt.altitude || 0 },
            ...((pt.history || []).map(h => ({
                date: Number(h.date), note: h.note || '', altitude: h.altitude || 0
            })))
        ].sort((a, b) => b.date - a.date);

        // Most recent non-empty note
        const latestNote = allForPt.find(e => e.note.trim() !== '')?.note || '';
        const lastConnectionDate = allForPt[0].date;

        connections.push({
            date: Number(pt.dateAdded),
            altitude: pt.altitude || 0,
            ssid: pt.ssid,
            city: pt.city || 'Unknown',
            country: pt.country || '',
            note: pt.note || '',
            latestNote,
            lastConnectionDate
        });

        (pt.history || []).forEach(h => {
            connections.push({
                date: Number(h.date),
                altitude: h.altitude || 0,
                ssid: pt.ssid,
                city: pt.city || 'Unknown',
                country: pt.country || '',
                note: h.note || '',
                latestNote,
                lastConnectionDate
            });
        });
    });
    connections.sort((a, b) => a.date - b.date);
    window._allConnections = connections;
}

function getCutoff(rangeStr) {
    const now = Date.now();
    switch (rangeStr) {
        case '1D': return now - 24 * 3600000;
        case '1W': return now - 7 * 24 * 3600000;
        case '1M': return now - 30 * 24 * 3600000;
        case '1Y': return now - 365 * 24 * 3600000;
        case 'ALL': default: return 0;
    }
}

function updateTimeline() {
    if (!window._allConnections) return;
    if (!window._timelineRange) window._timelineRange = '1M';
    const cutoff = getCutoff(window._timelineRange);
    const filtered = window._allConnections.filter(c => c.date >= cutoff);

    const container = document.getElementById('connection-timeline');
    if (!container) return;
    container.innerHTML = '';

    if (filtered.length === 0) {
        container.innerHTML = '<div style="width:100%;text-align:center;color:var(--slate-light);padding:40px 0;">No connections in this range.</div>';
        return;
    }

    // Determine the actual time span of visible data
    const minDate = filtered[0].date;
    const maxDate = filtered[filtered.length - 1].date;
    const totalMs = maxDate - minDate || 1;

    const minSpacing = 10;   // px tight baseline
    const maxSpacing = 90;   // px cap to avoid wide gaps

    // Build nodes first (needed to measure widths for the SVG line)
    const nodes = [];
    filtered.forEach((conn, idx) => {
        const node = document.createElement('div');
        node.className = 'timeline-node';

        const d = new Date(conn.date);
        const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const locStr = conn.city || 'Unknown';
        // Show most recent non-empty note for this network
        const displayNote = conn.latestNote || '';
        const noteHtml = displayNote
            ? `<div class="popover-note" style="margin-top:3px;border-top:1px solid rgba(255,255,255,0.07);padding-top:3px;">${displayNote}</div>` : '';
        // Last connection date for this network
        const lastDate = conn.lastConnectionDate
            ? new Date(conn.lastConnectionDate).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            : null;

        node.innerHTML = `
            <div class="timeline-date">
                <span style="display:block;font-size:0.6rem;line-height:1.2;color:var(--slate-light);">${dateStr}</span>
                <span style="display:block;font-size:0.65rem;font-weight:600;line-height:1.3;color:var(--teal);">${timeStr}</span>
            </div>
            <div class="timeline-dot"></div>
            <div class="timeline-loc" title="${locStr}">${locStr}</div>
            <div class="timeline-popover">
                <div class="popover-ssid">${conn.ssid || 'Unknown'}</div>
                <div class="popover-note">${dateStr} · ${timeStr}</div>
                ${lastDate && conn.lastConnectionDate !== conn.date ? `<div class="popover-note" style="color:var(--teal);font-size:0.7rem;">Last: ${lastDate}</div>` : ''}
                <div class="popover-note">Alt: ${conn.altitude}m</div>
                ${noteHtml}
            </div>
        `;

        node.addEventListener('click', () => {
            document.querySelectorAll('.timeline-node.show-popover').forEach(n => {
                if (n !== node) n.classList.remove('show-popover');
            });
            node.classList.toggle('show-popover');
        });

        // Proportional spacing: log1p compresses outlier gaps more than sqrt
        if (idx < filtered.length - 1) {
            const diffMs = filtered[idx + 1].date - conn.date;
            let ratio = diffMs / totalMs;
            if (ratio > 1) ratio = 1; else if (ratio < 0) ratio = 0;
            ratio = Math.log1p(ratio * 20) / Math.log1p(20);
            const spacing = minSpacing + (maxSpacing - minSpacing) * ratio;
            node.style.marginRight = `${Math.round(spacing)}px`;
        }

        container.appendChild(node);
        nodes.push(node);
    });

    // Draw SVG connecting line through all dot centres after layout
    requestAnimationFrame(() => {
        const existingSvg = container.querySelector('svg.timeline-line');
        if (existingSvg) existingSvg.remove();

        const containerRect = container.getBoundingClientRect();
        const dotCentres = nodes.map(n => {
            const dot = n.querySelector('.timeline-dot');
            if (!dot) return null;
            const r = dot.getBoundingClientRect();
            return {
                x: r.left - containerRect.left + container.scrollLeft + r.width / 2,
                y: r.top - containerRect.top + r.height / 2
            };
        }).filter(Boolean);

        if (dotCentres.length < 2) return;

        const totalW = dotCentres[dotCentres.length - 1].x + 20;
        const svgH = containerRect.height;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('timeline-line');
        svg.setAttribute('width', totalW);
        svg.setAttribute('height', svgH);
        svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;overflow:visible;';

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        let d = `M ${dotCentres[0].x} ${dotCentres[0].y}`;
        for (let i = 1; i < dotCentres.length; i++) {
            const prev = dotCentres[i - 1];
            const cur = dotCentres[i];
            const mx = (prev.x + cur.x) / 2;
            d += ` C ${mx} ${prev.y} ${mx} ${cur.y} ${cur.x} ${cur.y}`;
        }
        path.setAttribute('d', d);
        path.setAttribute('stroke', 'rgba(20,184,166,0.45)');
        path.setAttribute('stroke-width', '2.5');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-linecap', 'round');
        svg.appendChild(path);
        container.insertBefore(svg, container.firstChild);
    });

    setTimeout(() => { container.scrollLeft = container.scrollWidth; }, 150);
}

function updateAltitudeTimeChart() {
    if (!charts.altitudeTime || !window._allConnections) return;
    if (!window._currentAltRange) window._currentAltRange = '1M';

    const cutoff = getCutoff(window._currentAltRange);
    const filtered = window._allConnections.filter(c => c.date >= cutoff);
    window._filteredAltConnections = filtered;

    const labels = filtered.map(c => {
        const d = new Date(c.date);
        return window._currentAltRange === '1D'
            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    });

    const data = filtered.map(c => c.altitude || 0);

    charts.altitudeTime.data = {
        labels: labels.length ? labels : ['No data'],
        datasets: [{
            label: 'Altitude (m)',
            data: data.length ? data : [0],
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245,158,11,0.1)',
            fill: true,
            pointBackgroundColor: '#f59e0b',
            pointRadius: data.length > 50 ? 2 : 4,
            tension: 0.2
        }]
    };
    charts.altitudeTime.options.plugins.legend.labels = { color: Chart.defaults.color };
    charts.altitudeTime.update();
}
