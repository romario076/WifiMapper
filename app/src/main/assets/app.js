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
function customAlert(message, title = 'Notice') {
    return new Promise(resolve => {
        document.getElementById('dialog-title').innerText = title;
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
        if (window.Android.fetchFriendData) {
            window.Android.fetchFriendData();
            if (window.Android.fetchAllFriendPoints) window.Android.fetchAllFriendPoints();
        }
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
//  Friend System
// ═══════════════════════════════════════════════════════════

window.onFriendActionSuccess = async function (action) {
    if (action === 'request_sent') await customAlert("Friend request sent!");
    else if (action === 'friend_removed') await customAlert("Friend removed successfully!");

    if (window.Android && window.Android.fetchFriendData) {
        window.Android.fetchFriendData();
        if (action === 'friend_removed' && window.Android.fetchAllFriendPoints) {
            window.Android.fetchAllFriendPoints(); // Sync map data after removal
        }
    }
};

window.onFriendActionError = function (errorMsg) {
    customAlert(errorMsg);
};

// Show modal to select access level when accepting a friend request
window.showAcceptModal = function (friendUid) {
    const modal = document.createElement('div');
    modal.id = 'accept-friend-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
        <div style="background:var(--bg-panel,#1e293b);padding:24px;border-radius:16px;max-width:320px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
            <h3 style="color:var(--teal);margin:0 0 8px 0;">Accept Friend Request</h3>
            <p style="color:var(--slate-light);font-size:0.85rem;margin:0 0 20px 0;">Choose what access to grant this friend:</p>
            <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
                <button id="accept-full-btn" style="background:rgba(20,184,166,0.15);border:1px solid var(--teal);padding:12px;border-radius:10px;color:var(--text-color,#f1f5f9);font-size:0.9rem;text-align:left;cursor:pointer;">
                    🗺️ <b>Full Access</b><br><span style="font-size:0.78rem;color:var(--slate-light);">See each other's Wi-Fi points on the map + full statistics</span>
                </button>
                <button id="accept-stats-btn" style="background:rgba(99,102,241,0.15);border:1px solid #818cf8;padding:12px;border-radius:10px;color:var(--text-color,#f1f5f9);font-size:0.9rem;text-align:left;cursor:pointer;">
                    📊 <b>Stats Only</b><br><span style="font-size:0.78rem;color:var(--slate-light);">Share only summary statistics — no map points visible</span>
                </button>
            </div>
            <button id="cancel-accept-btn" style="background:transparent;border:1px solid rgba(255,255,255,0.1);color:var(--slate-light);width:100%;padding:8px;border-radius:8px;cursor:pointer;">Cancel</button>
        </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('accept-full-btn').onclick = () => {
        modal.remove();
        if (window.Android) window.Android.acceptFriendRequest(friendUid, 'full');
    };
    document.getElementById('accept-stats-btn').onclick = () => {
        modal.remove();
        if (window.Android) window.Android.acceptFriendRequest(friendUid, 'stats');
    };
    document.getElementById('cancel-accept-btn').onclick = () => modal.remove();
};

// Change access level — clean radio-button UI
window.showChangeAccessModal = function (friendUid, currentLevel) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
        <div style="background:var(--bg-panel,#1e293b);padding:24px;border-radius:16px;max-width:310px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
            <h3 style="color:var(--teal);margin:0 0 4px 0;font-size:1rem;">Access Level</h3>
            <p style="color:var(--slate-light);font-size:0.8rem;margin:0 0 18px 0;">Choose what to share with this friend:</p>
            <label style="display:flex;align-items:flex-start;gap:12px;background:rgba(20,184,166,0.08);border:1px solid ${currentLevel === 'full' ? 'var(--teal)' : 'rgba(255,255,255,0.08)'};border-radius:10px;padding:12px;cursor:pointer;margin-bottom:10px;">
                <input type="radio" name="access-level" value="full" ${currentLevel === 'full' ? 'checked' : ''} style="margin-top:3px;accent-color:var(--teal);">
                <div>
                    <div style="font-weight:600;font-size:0.9rem;">🗺️ Full Access</div>
                    <div style="font-size:0.75rem;color:var(--slate-light);margin-top:2px;">Map points + full statistics visible to each other</div>
                </div>
            </label>
            <label style="display:flex;align-items:flex-start;gap:12px;background:rgba(99,102,241,0.08);border:1px solid ${currentLevel === 'stats' ? '#818cf8' : 'rgba(255,255,255,0.08)'};border-radius:10px;padding:12px;cursor:pointer;margin-bottom:18px;">
                <input type="radio" name="access-level" value="stats" ${currentLevel === 'stats' ? 'checked' : ''} style="margin-top:3px;accent-color:#818cf8;">
                <div>
                    <div style="font-weight:600;font-size:0.9rem;">📊 Stats Only</div>
                    <div style="font-size:0.75rem;color:var(--slate-light);margin-top:2px;">Only aggregated statistics — no map points shared</div>
                </div>
            </label>
            <div style="display:flex;gap:8px;">
                <button id="change-access-cancel" style="flex:1;background:transparent;border:1px solid rgba(255,255,255,0.1);color:var(--slate-light);padding:10px;border-radius:8px;cursor:pointer;">Cancel</button>
                <button id="change-access-save" style="flex:1;background:var(--teal);color:#fff;border:none;padding:10px;border-radius:8px;cursor:pointer;font-weight:600;">Save</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('change-access-save').onclick = () => {
        const selected = modal.querySelector('input[name="access-level"]:checked')?.value || currentLevel;
        modal.remove();
        if (selected !== currentLevel && window.Android && window.Android.updateFriendAccess) {
            window.Android.updateFriendAccess(friendUid, selected);
        }
    };
    document.getElementById('change-access-cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
};

// Callback: friend stats received from Android
window._friendStatsCache = {};
window.onFriendStatsReceived = function (jsonStr) {
    try {
        const stats = JSON.parse(jsonStr);
        window._friendStatsCache[stats.uid] = stats;
        renderFriendStatsCards();
    } catch (e) { console.error('onFriendStatsReceived error', e); }
};

function renderFriendStatsCards() {
    const container = document.getElementById('friends-stats-cards');
    if (!container) return;
    const entries = Object.entries(window._friendStatsCache);
    if (entries.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = entries.map(([uid, stats]) => {
        const p = (window.lastFriendProfiles || {})[uid] || { displayName: 'Friend', photoUrl: '', accessLevel: 'full' };
        const img = p.photoUrl ? `<img src="${p.photoUrl}" style="width:22px;height:22px;border-radius:50%;object-fit:cover;">` : '👤';
        const badge = p.accessLevel === 'full' ? `<span style="font-size:0.6rem;background:rgba(20,184,166,0.2);color:var(--teal);padding:1px 5px;border-radius:3px;">🗺️Full</span>` : `<span style="font-size:0.6rem;background:rgba(99,102,241,0.2);color:#818cf8;padding:1px 5px;border-radius:3px;">📊Stats</span>`;
        return `<div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:10px 12px;">
            <div style="display:flex;align-items:center;gap:7px;margin-bottom:7px;">
                ${img}
                <span style="font-weight:600;font-size:0.85rem;">${p.displayName}</span>
                ${badge}
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:4px;font-size:0.72rem;text-align:center;">
                <div style="background:rgba(20,184,166,0.07);border-radius:5px;padding:4px 2px;"><div style="color:var(--slate-light);font-size:0.58rem;">Countries</div><b style="color:var(--teal);">${stats.countries}</b></div>
                <div style="background:rgba(139,92,246,0.07);border-radius:5px;padding:4px 2px;"><div style="color:var(--slate-light);font-size:0.58rem;">Cities</div><b style="color:#8b5cf6;">${stats.cities}</b></div>
                <div style="background:rgba(99,102,241,0.07);border-radius:5px;padding:4px 2px;"><div style="color:var(--slate-light);font-size:0.58rem;">Locations</div><b style="color:#818cf8;">${stats.uniqueNetworks}</b></div>
                <div style="background:rgba(59,130,246,0.07);border-radius:5px;padding:4px 2px;"><div style="color:var(--slate-light);font-size:0.58rem;">WiFi</div><b style="color:#3b82f6;">${stats.uniqueWifi || 0}</b></div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:4px;font-size:0.72rem;text-align:center;">
                <div style="background:rgba(255,255,255,0.04);border-radius:5px;padding:4px 2px;"><div style="color:var(--slate-light);font-size:0.58rem;">Conns</div><b>${stats.totalConnections}</b></div>
                <div style="background:rgba(255,255,255,0.04);border-radius:5px;padding:4px 2px;"><div style="color:var(--slate-light);font-size:0.58rem;">Min Alt</div><b>${Math.round(stats.minAltitude)}m</b></div>
                <div style="background:rgba(255,255,255,0.04);border-radius:5px;padding:4px 2px;"><div style="color:var(--slate-light);font-size:0.58rem;">Avg Alt</div><b>${stats.avgAltitude !== undefined ? Math.round(stats.avgAltitude) + 'm' : '—'}</b></div>
                <div style="background:rgba(255,255,255,0.04);border-radius:5px;padding:4px 2px;"><div style="color:var(--slate-light);font-size:0.58rem;">Max Alt</div><b>${Math.round(stats.maxAltitude)}m</b></div>
            </div>
            <div style="background:rgba(234,179,8,0.07);border-radius:5px;padding:5px 8px;display:flex;align-items:center;gap:6px;">
                <span style="font-size:1rem;">🚀</span>
                <div style="min-width:0;">
                    <div style="color:var(--slate-light);font-size:0.58rem;text-transform:uppercase;">Furthest Discovery</div>
                    <div style="color:#eab308;font-size:0.72rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${stats.furthestDiscovery || 'No Home Set'}</div>
                </div>
            </div>
        </div>`;
    }).join('');
}

// ─── My Privacy Block ─────────────────────────────────────────────────────────
window._myDefaultAccessLevel = localStorage.getItem('myDefaultAccessLevel') || 'full';

function renderMyPrivacyBlock() {
    const existing = document.getElementById('my-privacy-block');
    const anchor = document.getElementById('friend-requests-container') || document.getElementById('friends-stats-cards');
    if (!anchor && !existing) return;
    const section = anchor?.closest('section') || existing?.closest('section');
    if (!section) return;

    if (!existing) {
        const block = document.createElement('div');
        block.id = 'my-privacy-block';
        block.style.cssText = 'margin-bottom:0.75rem;padding-bottom:0.75rem;border-bottom:1px solid rgba(255,255,255,0.08);';
        section.insertBefore(block, section.firstChild);
    }
    const level = window._myDefaultAccessLevel;
    document.getElementById('my-privacy-block').innerHTML = `
        <div style="margin-bottom:6px;">
            <h4 style="font-size:0.88rem;color:var(--teal);margin:0 0 2px 0;">🔒 My Privacy</h4>
            <p style="font-size:0.7rem;color:var(--slate-light);margin:0 0 6px 0;">What do you share with friends</p>
        </div>
        <div style="display:flex;gap:8px;">
            <label style="flex:1;display:flex;align-items:center;gap:8px;background:rgba(20,184,166,${level === 'full' ? '0.12' : '0.04'});border:1px solid ${level === 'full' ? 'var(--teal)' : 'rgba(255,255,255,0.08)'};border-radius:8px;padding:8px 10px;cursor:pointer;">
                <input type="radio" name="my-privacy" value="full" ${level === 'full' ? 'checked' : ''} style="accent-color:var(--teal);" onchange="window.setMyDefaultAccess('full')">
                <div><div style="font-size:0.8rem;font-weight:600;">🗺️ Full</div><div style="font-size:0.68rem;color:var(--slate-light);">Map + Stats</div></div>
            </label>
            <label style="flex:1;display:flex;align-items:center;gap:8px;background:rgba(99,102,241,${level === 'stats' ? '0.12' : '0.04'});border:1px solid ${level === 'stats' ? '#818cf8' : 'rgba(255,255,255,0.08)'};border-radius:8px;padding:8px 10px;cursor:pointer;">
                <input type="radio" name="my-privacy" value="stats" ${level === 'stats' ? 'checked' : ''} style="accent-color:#818cf8;" onchange="window.setMyDefaultAccess('stats')">
                <div><div style="font-size:0.8rem;font-weight:600;">📊 Stats Only</div><div style="font-size:0.68rem;color:var(--slate-light);">No map points</div></div>
            </label>
        </div>`;
}

window.setMyDefaultAccess = function (level) {
    window._myDefaultAccessLevel = level;
    localStorage.setItem('myDefaultAccessLevel', level);
    renderMyPrivacyBlock();
    if (window.Android && window.Android.setMyDefaultPrivacy) {
        window.Android.setMyDefaultPrivacy(level);
    }
};



window.showFriendStats = function (uid) {
    const cachedStats = (window._friendStatsCache || {})[uid];
    const profile = (window.lastFriendProfiles || {})[uid] || { displayName: 'Friend', email: '', photoUrl: '' };
    const pts = (window.friendWifiPoints || []).filter(p => String(p.ownerId) === String(uid));

    // Merge live map points with cached server stats
    const countries = cachedStats ? cachedStats.countries : new Set(pts.map(p => p.country).filter(Boolean)).size;
    const cities = cachedStats ? cachedStats.cities : new Set(pts.map(p => p.city).filter(Boolean)).size;
    const networks = cachedStats ? cachedStats.uniqueNetworks : pts.length;
    const uniqueWifi = cachedStats ? (cachedStats.uniqueWifi || 0) : pts.filter(p => !p.networkType || p.networkType === 'wifi').length;
    const conns = cachedStats ? cachedStats.totalConnections : pts.reduce((s, p) => s + (Number(p.connections) || 1), 0);
    const minAlt = cachedStats ? Math.round(cachedStats.minAltitude) : '—';
    const avgAlt = cachedStats ? (cachedStats.avgAltitude !== undefined ? Math.round(cachedStats.avgAltitude) + 'm' : '—') : '—';
    const maxAlt = cachedStats ? Math.round(cachedStats.maxAltitude) : '—';
    const furthestDesc = cachedStats ? (cachedStats.furthestDiscovery || 'No Home Set') : (wifiPoints.find(h => h.isHome) ? 'Available via Cloud UI' : 'No Home Set');

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
        <div style="background:var(--bg-panel,#1e293b);padding:16px;border-radius:16px;max-width:340px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
            <div style="text-align:center;margin-bottom:10px;">
                ${profile.photoUrl ? `<img src="${profile.photoUrl}" style="width:44px;height:44px;border-radius:50%;border:2px solid var(--teal);object-fit:cover;">` : '<span style="font-size:32px;">👤</span>'}
                <div style="font-weight:700;font-size:0.92rem;margin-top:5px;">${profile.displayName}</div>
                <div style="font-size:0.7rem;color:var(--slate-light);">${profile.email}</div>
            </div>
            <!-- Row 1: Countries · Cities · Locations -->
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin-bottom:5px;">
                <div style="text-align:center;background:rgba(20,184,166,0.08);padding:7px 4px;border-radius:7px;">
                    <div style="font-size:0.58rem;color:var(--slate-light);text-transform:uppercase;">Countries</div>
                    <b style="font-size:1rem;color:var(--teal);">${countries}</b>
                </div>
                <div style="text-align:center;background:rgba(139,92,246,0.08);padding:7px 4px;border-radius:7px;">
                    <div style="font-size:0.58rem;color:var(--slate-light);text-transform:uppercase;">Cities</div>
                    <b style="font-size:1rem;color:#8b5cf6;">${cities}</b>
                </div>
                <div style="text-align:center;background:rgba(99,102,241,0.08);padding:7px 4px;border-radius:7px;">
                    <div style="font-size:0.58rem;color:var(--slate-light);text-transform:uppercase;">Locations</div>
                    <b style="font-size:1rem;color:#818cf8;">${networks}</b>
                </div>
            </div>
            <!-- Row 2: Unique WiFi · Connections · Min · Avg · Max Alt -->
            <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:5px;margin-bottom:5px;">
                <div style="text-align:center;background:rgba(59,130,246,0.08);padding:7px 2px;border-radius:7px;">
                    <div style="font-size:0.55rem;color:var(--slate-light);text-transform:uppercase;">WiFi</div>
                    <b style="font-size:0.95rem;color:#3b82f6;">${uniqueWifi}</b>
                </div>
                <div style="text-align:center;background:rgba(255,255,255,0.05);padding:7px 2px;border-radius:7px;">
                    <div style="font-size:0.55rem;color:var(--slate-light);text-transform:uppercase;">Conns</div>
                    <b style="font-size:0.95rem;">${conns}</b>
                </div>
                <div style="text-align:center;background:rgba(255,255,255,0.05);padding:7px 2px;border-radius:7px;">
                    <div style="font-size:0.55rem;color:var(--slate-light);text-transform:uppercase;">Min Alt</div>
                    <b style="font-size:0.95rem;">${minAlt}m</b>
                </div>
                <div style="text-align:center;background:rgba(255,255,255,0.05);padding:7px 2px;border-radius:7px;">
                    <div style="font-size:0.55rem;color:var(--slate-light);text-transform:uppercase;">Avg Alt</div>
                    <b style="font-size:0.95rem;">${avgAlt}</b>
                </div>
                <div style="text-align:center;background:rgba(255,255,255,0.05);padding:7px 2px;border-radius:7px;">
                    <div style="font-size:0.55rem;color:var(--slate-light);text-transform:uppercase;">Max Alt</div>
                    <b style="font-size:0.95rem;">${maxAlt}m</b>
                </div>
            </div>
            <!-- Row 3: Furthest Discovery -->
            <div style="background:rgba(234,179,8,0.08);padding:8px 10px;border-radius:8px;display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                <span style="font-size:1.1rem;flex-shrink:0;">🚀</span>
                <div style="min-width:0;">
                    <div style="font-size:0.58rem;color:var(--slate-light);text-transform:uppercase;">Furthest Discovery</div>
                    <div style="font-size:0.8rem;font-weight:700;color:#eab308;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${furthestDesc}</div>
                </div>
            </div>
            <button id="friend-stats-close" style="background:var(--teal);color:#fff;border:none;width:100%;padding:8px;border-radius:8px;cursor:pointer;font-size:0.85rem;">Close</button>
        </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('friend-stats-close').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
};

window.lastFriendProfiles = {};
window.activeFriendFilters = new Set();
window._hideMyPoints = false;

window.onFriendDataReceived = function (jsonStr) {
    try {
        const data = JSON.parse(jsonStr);
        window.lastFriendProfiles = data.profiles || {};

        // Sync My Privacy level from server (source of truth)
        if (data.myPrivacyLevel) {
            window._myDefaultAccessLevel = data.myPrivacyLevel;
            localStorage.setItem('myDefaultAccessLevel', data.myPrivacyLevel);
        }

        const filterPanel = document.getElementById('friend-filter-panel');
        if (filterPanel) {
            filterPanel.innerHTML = '';
            const meBtn = document.createElement('div');
            meBtn.style.cssText = `width:40px; height:40px; border-radius:50%; background:var(--bg-panel); display:flex; align-items:center; justify-content:center; font-size:20px; border:2px solid var(--primary); cursor:pointer; box-shadow:0 2px 5px rgba(0,0,0,0.3); transition: transform 0.2s; opacity: ${window._hideMyPoints ? '0.4' : '1'};`;
            meBtn.title = "Show/Hide My Points";
            meBtn.innerHTML = "📍";
            meBtn.onclick = () => {
                window._hideMyPoints = !window._hideMyPoints;
                meBtn.style.opacity = window._hideMyPoints ? '0.4' : '1';
                meBtn.style.border = window._hideMyPoints ? '2px solid transparent' : '2px solid var(--primary)';
                renderMarkers();
                if (typeof updateCharts === 'function') updateCharts();
            };
            filterPanel.appendChild(meBtn);

            if (data.friends && data.friends.length > 0) {
                data.friends.forEach(uid => {
                    const profile = data.profiles[uid] || { displayName: 'Unknown', photoUrl: '' };
                    const imgStr = profile.photoUrl ? profile.photoUrl : 'https://ui-avatars.com/api/?name=' + encodeURIComponent(profile.displayName);
                    const btn = document.createElement('div');
                    const uidStr = String(uid);
                    // Friends are OFF by default — only active if user previously toggled them on
                    const isActive = window.activeFriendFilters.has(uidStr);

                    btn.style.cssText = `width:40px; height:40px; border-radius:50%; background:url('${imgStr}') center/cover; border:2px solid ${isActive ? 'var(--teal)' : 'transparent'}; cursor:pointer; box-shadow:0 2px 5px rgba(0,0,0,0.3); transition: transform 0.2s; opacity: ${isActive ? '1' : '0.4'};`;
                    btn.title = profile.displayName;

                    btn.onclick = () => {
                        if (window.activeFriendFilters.has(uidStr)) {
                            window.activeFriendFilters.delete(uidStr);
                            btn.style.opacity = '0.4';
                            btn.style.border = '2px solid transparent';
                        } else {
                            window.activeFriendFilters.add(uidStr);
                            btn.style.opacity = '1';
                            btn.style.border = '2px solid var(--teal)';
                        }
                        renderMarkers();
                        if (typeof updateCharts === 'function') updateCharts();
                        detectRouteCrossings();
                    };
                    filterPanel.appendChild(btn);
                });
            }
        }

        const reqList = document.getElementById('friend-requests-list');
        const fList = document.getElementById('friends-list');
        const reqContainer = document.getElementById('friend-requests-container');
        if (!reqList || !fList) return;

        reqList.innerHTML = '';
        fList.innerHTML = '';

        if (data.requests && data.requests.length > 0) {
            reqContainer.classList.remove('hidden');
            data.requests.forEach(uid => {
                const profile = data.profiles[uid] || { displayName: 'Unknown', photoUrl: '', email: '' };
                const imgStr = profile.photoUrl ? `<img src="${profile.photoUrl}" style="width:32px; height:32px; border-radius:50%; object-fit:cover;">` : '<span style="font-size:24px;">👤</span>';
                reqList.innerHTML += `
                    <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.05); padding:8px 12px; border-radius:8px;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            ${imgStr}
                            <div>
                                <div style="font-weight:600; font-size:0.9rem;">${profile.displayName}</div>
                                <div style="font-size:0.75rem; color:var(--slate-light);">${profile.email}</div>
                            </div>
                        </div>
                        <div style="display:flex; gap:6px;">
                            <button onclick="window.showAcceptModal('${uid}')" style="background:var(--success); color:#fff; border:none; width:30px; height:30px; border-radius:4px; cursor:pointer;" title="Accept">✓</button>
                            <button onclick="if(window.Android) window.Android.rejectFriendRequest('${uid}')" style="background:var(--danger); color:#fff; border:none; width:30px; height:30px; border-radius:4px; cursor:pointer;" title="Reject">✕</button>
                        </div>
                    </div>
                `;
            });
        } else {
            reqContainer.classList.add('hidden');
        }

        if (data.friends && data.friends.length > 0) {
            data.friends.forEach(uid => {
                const profile = data.profiles[uid] || { displayName: 'Unknown', photoUrl: '', email: '', lastActive: 0, accessLevel: 'full' };
                const isOnline = Date.now() - (profile.lastActive || 0) < 5 * 60 * 1000;
                const dotColor = isOnline ? '#10b981' : '#64748b';
                const accessLevel = profile.accessLevel || 'full';
                const accessBadge = accessLevel === 'full'
                    ? `<span style="font-size:0.65rem; background:rgba(20,184,166,0.2); color:var(--teal); padding:2px 6px; border-radius:4px;">🗺️ Full</span>`
                    : `<span style="font-size:0.65rem; background:rgba(99,102,241,0.2); color:#818cf8; padding:2px 6px; border-radius:4px;">📊 Stats</span>`;

                const imgStr = profile.photoUrl ? `<img src="${profile.photoUrl}" style="width:32px; height:32px; border-radius:50%; object-fit:cover;">` : '<span style="font-size:24px;">👤</span>';
                fList.innerHTML += `
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; background:rgba(255,255,255,0.05); padding:8px 12px; border-radius:8px;">
                        <div style="display:flex; align-items:center; gap:10px; flex:1;">
                            <div style="position:relative;">
                                ${imgStr}
                                <div style="position:absolute; bottom:0; right:-2px; width:12px; height:12px; background:${dotColor}; border:2px solid var(--glass-bg, #0f172a); border-radius:50%;"></div>
                            </div>
                            <div>
                                <div style="font-weight:600; font-size:0.9rem;">${profile.displayName} ${accessBadge}</div>
                                <div style="font-size:0.75rem; color:var(--slate-light);">${profile.email}</div>
                            </div>
                        </div>
                        <div style="display:flex; gap:8px;">
                            <button onclick="window.showChangeAccessModal('${uid}', '${accessLevel}')" style="background:rgba(99,102,241,0.2); color:#818cf8; border:1px solid rgba(99,102,241,0.4); width:30px; height:30px; border-radius:4px; cursor:pointer; font-size:0.85rem;" title="Change Access Level">🔑</button>
                            <button onclick="window.showFriendStats('${uid}')" style="background:var(--teal); color:#fff; border:none; width:30px; height:30px; border-radius:4px; cursor:pointer;" title="View Stats">📊</button>
                            <button onclick="if(confirm('Remove this friend?')) { if(window.Android) window.Android.removeFriend('${uid}') }" style="background:var(--danger, #ef4444); color:#fff; border:none; width:30px; height:30px; border-radius:4px; cursor:pointer;" title="Remove Friend">╳</button>
                        </div>
                    </div>
                `;

                // Always fetch stats for every friend regardless of access level
                if (window.Android && window.Android.fetchFriendStats) {
                    window.Android.fetchFriendStats(uid);
                }
            });
        } else {
            fList.innerHTML = '<p style="color:var(--slate-light); font-size:0.9rem;">Adding friends will allow you to share network points. Search their Google login email above to send a request.</p>';
        }

    } catch (e) {
        console.error("Error parsing friend data", e);
    }

    // Inject stats cards container below friends list (once)
    const fView = document.getElementById('friend-requests-list')?.closest('section') ||
        document.getElementById('friends-list')?.closest('section');
    if (fView && !document.getElementById('friends-stats-cards')) {
        const statsContainer = document.createElement('div');
        statsContainer.id = 'friends-stats-cards';
        statsContainer.style.cssText = 'padding: 0 1rem 1rem; margin-top: 10px;';
        fView.appendChild(statsContainer);
    }

    // Inject map extra controls into Leaflet's left column (below zoom buttons)
    if (!document.getElementById('map-extra-controls')) {
        const insertControls = () => {
            const leafletLeft = document.querySelector('.leaflet-top.leaflet-left');
            if (!leafletLeft) { setTimeout(insertControls, 300); return; }

            const wrap = document.createElement('div');
            wrap.id = 'map-extra-controls';
            wrap.className = 'leaflet-bar leaflet-control';
            wrap.style.cssText = 'margin-top:6px;display:flex;flex-direction:column;gap:0;border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,0.14);';

            // Crossings toggle
            const crossBtn = document.createElement('a');
            crossBtn.id = 'toggle-crossings-btn';
            crossBtn.href = '#';
            crossBtn.title = 'Toggle shared network crossings';
            crossBtn.style.cssText = 'width:30px;height:30px;background:var(--bg-panel,#1e293b);color:var(--slate-light);display:flex;align-items:center;justify-content:center;font-size:14px;text-decoration:none;opacity:0.55;transition:opacity 0.2s,color 0.2s;border-bottom:1px solid rgba(255,255,255,0.1);';
            crossBtn.innerHTML = '⚡';
            crossBtn.onclick = (e) => { e.preventDefault(); window.toggleCrossings(); };
            wrap.appendChild(crossBtn);

            leafletLeft.appendChild(wrap);
        };
        insertControls();
    }

    renderFriendStatsCards();
    renderMyPrivacyBlock();
};

window.friendWifiPoints = [];
window.onFriendPointsLoaded = function (jsonStr) {
    try {
        const arr = JSON.parse(jsonStr);
        window.friendWifiPoints = arr.map(p => ({
            ...p,
            dateAdded: Number(p.dateAdded) || Date.now(),
            connections: Number(p.connections) || 1,
            history: Array.isArray(p.history) ? p.history : []
        }));
        renderMarkers();
        if (typeof updateCharts === 'function') updateCharts();
        // Auto-detect crossings if any friends are active
        if (window.activeFriendFilters && window.activeFriendFilters.size > 0) {
            detectRouteCrossings();
        }
    } catch (e) {
        console.error("Error parsing friend points:", e);
    }
};

// ─── Route Crossings Detection ───────────────────────────────────────────────
window._crossingLayerGroup = null;
window._showCrossings = false; // OFF by default — enable manually

function detectRouteCrossings() {
    if (!window.friendWifiPoints || !wifiPoints || !map) return;
    if (!window._crossingLayerGroup) {
        window._crossingLayerGroup = L.layerGroup().addTo(map);
    }
    window._crossingLayerGroup.clearLayers();
    if (!window._showCrossings) return;

    const activeFriendPts = window.friendWifiPoints.filter(p =>
        window.activeFriendFilters.has(String(p.ownerId))
    );
    if (activeFriendPts.length === 0) return;

    const crossings = [];
    wifiPoints.forEach(myPt => {
        if (!myPt.ssid || myPt.lat == null) return;
        const matched = activeFriendPts.filter(fp => fp.ssid === myPt.ssid && fp.lat != null);
        matched.forEach(fp => {
            // Check proximity (within ~200 metres = same access point)
            const dist = getDistance(myPt.lat, myPt.lng, fp.lat, fp.lng);
            if (dist > 500) return; // too far apart — different APs with same name

            const friendProfile = (window.lastFriendProfiles || {})[String(fp.ownerId)] || { displayName: 'Your friend' };
            const myDate = Number(myPt.dateAdded || myPt.date || 0);
            const friendDate = Number(fp.dateAdded || fp.date || 0);
            const diffMs = Math.abs(myDate - friendDate);
            const diffDays = Math.round(diffMs / 86400000);
            const diffStr = diffDays < 30
                ? `${diffDays} day${diffDays !== 1 ? 's' : ''}`
                : `${Math.round(diffDays / 30)} month${Math.round(diffDays / 30) !== 1 ? 's' : ''}`;

            const iWasFirst = myDate < friendDate;
            const whoFirst = (!myDate || !friendDate) ? 'Both discovered this Wi-Fi' : (iWasFirst
                ? `You discovered it <b>${diffStr} earlier</b> than ${friendProfile.displayName}`
                : `${friendProfile.displayName} discovered it <b>${diffStr} earlier</b> than you`);

            const formatDate = (ts) => {
                if (!ts || isNaN(ts)) return 'Unknown Date';
                return new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            };
            const myDateStr = formatDate(myDate);
            const fdDateStr = formatDate(friendDate);

            crossings.push({
                lat: myPt.lat,
                lng: myPt.lng,
                ssid: myPt.ssid,
                whoFirst,
                myDateStr,
                fdDateStr,
                friendName: friendProfile.displayName,
                myCity: myPt.city || 'Unknown',
                myCountry: myPt.country || 'Unknown',
                myAlt: myPt.altitude != null ? Math.round(myPt.altitude) : '—',
                myNote: myPt.note || '',
                fdCity: fp.city || 'Unknown',
                fdCountry: fp.country || 'Unknown',
                fdAlt: fp.altitude != null ? Math.round(fp.altitude) : '—',
                fdNote: fp.note || ''
            });
        });
    });

    crossings.forEach(c => {
        // Animated glowing pulse marker
        const icon = L.divIcon({
            className: '',
            html: `<div style="position:relative;width:36px;height:36px;display:flex;align-items:center;justify-content:center;">
                <div style="position:absolute;width:36px;height:36px;border-radius:50%;background:rgba(245,158,11,0.22);animation:cxPulse 1.8s ease-out infinite;"></div>
                <div style="position:absolute;width:26px;height:26px;border-radius:50%;background:rgba(245,158,11,0.32);border:1.5px solid rgba(255,200,50,0.55);"></div>
                <div style="position:relative;z-index:2;width:20px;height:20px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#d97706);border:2px solid #fff;box-shadow:0 0 10px rgba(245,158,11,0.9);display:flex;align-items:center;justify-content:center;font-size:10px;">&#9889;</div>
                </div>
                <style>@keyframes cxPulse{0%{transform:scale(.7);opacity:.9}100%{transform:scale(1.8);opacity:0}}</style>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
            popupAnchor: [0, -22]
        });

        const popupHtml = `<div class="custom-popup" style="min-width:215px;max-width:245px;font-size:0.82rem;">
            <div style="display:flex;align-items:center;gap:7px;margin-bottom:6px;">
                <span style="font-size:1.3rem;line-height:1;">&#9889;</span>
                <div style="color:#f59e0b;font-weight:700;font-size:0.95em;line-height:1.2;">Route Crossing</div>
            </div>
            
            <div style="color:var(--text-color,#f1f5f9);font-weight:600;font-size:0.95rem;margin-bottom:2px;">${c.ssid}</div>
            <div style="color:var(--slate-light);font-size:0.75rem;">📍 ${c.myCity}, ${c.myCountry}</div>
            <div style="color:var(--slate-light);font-size:0.75rem;margin-bottom:4px;">🏔️ ${c.myAlt}m</div>
            
            <div style="border-top:1px solid rgba(255,255,255,0.08);margin:6px 0;"></div>

            <div style="margin-bottom:6px;">
                <span style="color:#94a3b8;font-weight:600;">👤 You:</span> <span style="font-size:0.75rem;">${c.myDateStr}</span>
                ${c.myNote ? `<br><span style="color:var(--teal,#14b8a6);font-size:0.75rem;">📝 ${c.myNote}</span>` : ''}
            </div>

            <div style="margin-bottom:6px;">
                <span style="color:#94a3b8;font-weight:600;">👤 ${c.friendName}:</span> <span style="font-size:0.75rem;">${c.fdDateStr}</span>
                ${c.fdNote ? `<br><span style="color:var(--teal,#14b8a6);font-size:0.75rem;">📝 ${c.fdNote}</span>` : ''}
            </div>

            <div style="border-top:1px solid rgba(255,255,255,0.08);margin:6px 0;"></div>
            
            <div style="text-align:center;">
                <span style="color:#10b981;font-size:0.8rem;font-weight:600;">&#127942; ${c.whoFirst}</span>
            </div>
        </div>`;

        L.marker([c.lat, c.lng], { icon })
            .bindPopup(popupHtml, { minWidth: 250 })
            .addTo(window._crossingLayerGroup);
    });
}

window.toggleCrossings = function () {
    window._showCrossings = !window._showCrossings;

    // Hide/show regular markers (both user and friend live in markerClusterGroup)
    if (window._showCrossings) {
        if (map && markerClusterGroup && map.hasLayer(markerClusterGroup)) {
            map.removeLayer(markerClusterGroup);
        }
    } else {
        if (map && markerClusterGroup && !map.hasLayer(markerClusterGroup)) {
            map.addLayer(markerClusterGroup);
        }
        if (window._crossingLayerGroup) window._crossingLayerGroup.clearLayers();
    }

    if (window._showCrossings) detectRouteCrossings();

    const btn = document.getElementById('toggle-crossings-btn');
    if (btn) {
        btn.style.opacity = window._showCrossings ? '1' : '0.5';
        btn.style.color = window._showCrossings ? '#f59e0b' : 'var(--slate-light)';
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

    const autoTrackPrivateToggle = document.getElementById('auto-track-private-toggle');
    if (autoTrackPrivateToggle) {
        const isPrivate = window.Android && window.Android.isAutoTrackPrivate
            ? window.Android.isAutoTrackPrivate()
            : localStorage.getItem('autoTrackPrivate') === 'true';
        autoTrackPrivateToggle.checked = isPrivate;
    }

    const welcomeToggle = document.getElementById('welcome-notification-toggle');
    if (welcomeToggle) {
        const val = localStorage.getItem('welcomeNotificationEnabled');
        welcomeToggle.checked = val === null ? true : val === 'true';
    }

    const allowCellularToggle = document.getElementById('allow-cellular-toggle');
    if (allowCellularToggle) {
        const val = localStorage.getItem('allowCellularCheckin');
        allowCellularToggle.checked = val === null ? true : val === 'true';
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

    const autoTrackPrivateToggle = document.getElementById('auto-track-private-toggle');
    if (autoTrackPrivateToggle) {
        autoTrackPrivateToggle.addEventListener('change', e => {
            const enabled = e.target.checked;
            localStorage.setItem('autoTrackPrivate', enabled);
            if (window.Android && window.Android.setAutoTrackPrivate) {
                window.Android.setAutoTrackPrivate(enabled);
            }
        });
    }

    const welcomeToggle = document.getElementById('welcome-notification-toggle');
    if (welcomeToggle) {
        welcomeToggle.addEventListener('change', e => {
            localStorage.setItem('welcomeNotificationEnabled', e.target.checked);
        });
    }

    const allowCellularToggle = document.getElementById('allow-cellular-toggle');
    if (allowCellularToggle) {
        allowCellularToggle.addEventListener('change', e => {
            localStorage.setItem('allowCellularCheckin', e.target.checked);
        });
    }

    const friendSearchBtn = document.getElementById('friend-search-btn');
    if (friendSearchBtn) {
        friendSearchBtn.addEventListener('click', () => {
            const email = document.getElementById('friend-search-input').value.trim();
            if (email) {
                if (window.Android && window.Android.sendFriendRequest) {
                    window.Android.sendFriendRequest(email);
                    document.getElementById('friend-search-input').value = '';
                } else {
                    customAlert("Friend requests require the Android app!");
                }
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
        const unifiedErrorMsg = 'No connection to Wi-Fi, mobile data, or geolocation is disabled.';

        if (!navigator.geolocation) {
            await customAlert(unifiedErrorMsg);
            return;
        }

        const allowCellularToggle = document.getElementById('allow-cellular-toggle');
        const allowCellular = allowCellularToggle ? allowCellularToggle.checked : true;
        let isWifi = false;
        let isCellular = false;
        let s = '';
        const isAndroid = /Android/i.test(navigator.userAgent);

        if (navigator.onLine) {
            if (isAndroid && window.Android && window.Android.getSSID) {
                s = window.Android.getSSID();
                if (!s || s.includes('<unknown ssid>') || s === '0x' || s.trim() === '') {
                    isCellular = true;
                } else {
                    isWifi = true;
                }
            } else {
                isWifi = true;
            }
        }

        if (!isWifi && !(isCellular && allowCellular)) {
            await customAlert(unifiedErrorMsg);
            return;
        }

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

            let detectedSSID = isWifi && s ? s.replace(/"/g, '') : (isCellular ? 'Cellular Data' : 'Manual Check-in');
            if (!isWifi && !isCellular) detectedSSID = defaultName;
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
                    if (pt.ssid === detectedSSID && getDistance(pt.lat, pt.lng, lat, lng) <= 400) {
                        duplicate = pt; break;
                    }
                }

                if (duplicate) {
                    if (!duplicate.history) duplicate.history = [];

                    const lastHist = duplicate.history.length > 0 ? duplicate.history[duplicate.history.length - 1] : null;
                    const prevDate = lastHist?.date || duplicate.dateAdded;
                    const prevNote = lastHist?.note || duplicate.note || '';

                    window._pendingDuplicateHistoryObj = { date: Date.now(), altitude: Math.round(altitude), note: '' };
                    duplicate.history.push(window._pendingDuplicateHistoryObj);
                    duplicate.connections += 1;
                    savePoint(duplicate);
                    renderMarkers();
                    if (document.getElementById('stats-view').classList.contains('active')) updateCharts();
                    map.setView([lat, lng], 14);
                    resetRegBtn();

                    const isWelcomeEn = localStorage.getItem('welcomeNotificationEnabled');
                    if (isWelcomeEn === null || isWelcomeEn === 'true') {
                        const dateStr = new Date(prevDate).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                        const noteStr = prevNote ? `\n\nPrevious Note:\n"${prevNote}"` : '';
                        await customAlert(`Last connection: ${dateStr}${noteStr}`, `Welcome back! 🎉`);
                    }

                    window.openEditModal(duplicate.id);
                    document.getElementById('edit-wifi-note').value = ''; // Ensure the note is empty by default
                    return;
                }

                document.getElementById('reg-wifi-name').value = detectedSSID;
                document.getElementById('reg-wifi-altitude').value = Math.round(altitude);
                document.getElementById('reg-wifi-note').value = '';
                setColor('reg-color-picker', '#14b8a6');
                document.getElementById('reg-location-info').innerText = `📍 ${city}, ${country}`;
                window.pendingNewPoint = { id: String(Date.now()), lat, lng, city, country, dateAdded: Date.now(), networkType: isCellular ? 'cellular' : 'wifi' };
                document.getElementById('registration-modal').classList.remove('hidden');
                resetRegBtn();
            };

            const attemptGeo = () => {
                navigator.geolocation.getCurrentPosition(
                    pos => processLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.altitude || 0),
                    async err => {
                        await customAlert(unifiedErrorMsg);
                        resetRegBtn();
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
            if (window.Android.fetchFriendData) {
                window.Android.fetchFriendData();
                window.Android.fetchAllFriendPoints();
            }
        } else {
            // Fallback for preview mode
            setTimeout(() => { hideLoading(); renderMarkers(); updateCharts(); }, 600);
        }
    });

    // Route Replay Logic
    window._replayLayerGroup = L.featureGroup();
    window._replayState = {
        playing: false,
        index: 0,
        timer: null,
        pts: [],
        lines: [] // queue of polylines to manage fading tails
    };

    window.startReplay = async function (startIndexOrId = 0) {
        if (window._replayState.playing) return;
        if (map && map.closePopup) map.closePopup();

        if (typeof buildGlobalConnections === 'function') buildGlobalConnections();
        const pts = window._allConnections || [];

        const validPts = pts.filter(p => p.lat != null && p.lng != null).sort((a, b) => {
            const tA = Number(a.dateAdded || a.date || 0);
            const tB = Number(b.dateAdded || b.date || 0);
            return tA - tB;
        });
        if (validPts.length < 2) {
            await customAlert("You need at least 2 connected points to replay a route.");
            return;
        }

        let targetIdx = 0;
        if (typeof startIndexOrId === 'string') {
            const found = validPts.findIndex(p => String(p.id) === String(startIndexOrId));
            if (found >= 0) targetIdx = found;
        } else {
            targetIdx = startIndexOrId;
        }

        window._replayState.pts = validPts;
        window._replayState.index = targetIdx;
        window._replayState.startIndex = targetIdx;
        window._replayState.lines = [];

        if (markerClusterGroup) map.removeLayer(markerClusterGroup);
        window._replayLayerGroup.clearLayers();
        window._replayLayerGroup.addTo(map);

        document.getElementById('replay-overlay').classList.remove('hidden');
        document.getElementById('replay-scrubber').max = validPts.length - 1;
        document.getElementById('replay-scrubber').value = targetIdx;
        document.getElementById('pause-replay-btn').innerText = '⏸';

        window._replayState.playing = true;
        playReplayTick();
    };

    document.getElementById('play-route-btn').addEventListener('click', () => {
        window.startReplay(0);
    });

    document.getElementById('pause-replay-btn').addEventListener('click', () => {
        if (!window._replayState.pts.length) return;
        window._replayState.playing = !window._replayState.playing;
        document.getElementById('pause-replay-btn').innerText = window._replayState.playing ? '⏸' : '▶️';
        if (window._replayState.playing) {
            playReplayTick();
        } else {
            clearTimeout(window._replayState.timer);
        }
    });

    document.getElementById('replay-scrubber').addEventListener('input', (e) => {
        const targetIdx = parseInt(e.target.value, 10);
        renderReplayState(targetIdx, false);
    });

    document.getElementById('stop-replay-btn').addEventListener('click', stopReplay);

    function stopReplay() {
        window._replayState.playing = false;
        clearTimeout(window._replayState.timer);
        document.getElementById('replay-overlay').classList.add('hidden');
        if (window._replayLayerGroup) window._replayLayerGroup.clearLayers();
        renderMarkers();
    }

    function renderReplayState(targetIndex, animate = true) {
        if (targetIndex < 0 || targetIndex >= window._replayState.pts.length) return;
        window._replayState.index = targetIndex;

        const pt = window._replayState.pts[targetIndex];
        const counterEl = document.getElementById('replay-step-counter');
        const locEl = document.getElementById('replay-location');
        const dateEl = document.getElementById('replay-date');

        if (counterEl) counterEl.innerText = `Route Replay (${targetIndex + 1}/${window._replayState.pts.length})`;
        if (locEl) locEl.innerHTML = `📍 ${pt.city || 'Unknown'}${pt.country ? ', ' + pt.country : ''} &mdash; <span style="font-size:0.9rem;font-weight:400;">${pt.ssid || 'Unknown'}</span>`;
        if (dateEl) dateEl.innerText = new Date(Number(pt.dateAdded || pt.date || 0)).toLocaleString();

        document.getElementById('replay-scrubber').value = targetIndex;

        window._replayLayerGroup.clearLayers();
        window._replayState.lines = [];

        const start = window._replayState.startIndex || 0;
        for (let i = start; i <= targetIndex; i++) {
            const currentPt = window._replayState.pts[i];
            const mColor = currentPt.markerColor || '#10b981';

            L.circleMarker([currentPt.lat, currentPt.lng], {
                radius: i === targetIndex ? 8 : 5,
                fillColor: mColor,
                color: '#fff',
                weight: i === targetIndex ? 3 : 1,
                fillOpacity: 1
            }).addTo(window._replayLayerGroup);

            if (i > start) {
                const prevPt = window._replayState.pts[i - 1];
                L.polyline([[prevPt.lat, prevPt.lng], [currentPt.lat, currentPt.lng]], {
                    color: '#3b82f6', weight: 3, opacity: 0.6
                }).addTo(window._replayLayerGroup);
            }
        }

        if (animate) {
            const prevPt = targetIndex > 0 ? window._replayState.pts[targetIndex - 1] : pt;
            const dist = (targetIndex > 0) ? getDistance(prevPt.lat, prevPt.lng, pt.lat, pt.lng) : 0;
            if (dist > 100000) {
                map.flyTo([pt.lat, pt.lng], map.getZoom() < 8 ? map.getZoom() : 8, { animate: true, duration: 1.5 });
            } else {
                map.panTo([pt.lat, pt.lng], { animate: true, duration: 0.5 });
            }
        } else {
            map.setView([pt.lat, pt.lng]);
        }
    }

    function playReplayTick() {
        if (!window._replayState.playing) return;

        renderReplayState(window._replayState.index, true);

        if (window._replayState.index < window._replayState.pts.length - 1) {
            window._replayState.index++;
            const selectEl = document.getElementById('replay-speed-select');
            const stepMs = selectEl ? parseInt(selectEl.value, 10) : 800;
            window._replayState.timer = setTimeout(playReplayTick, stepMs);
        } else {
            setTimeout(() => {
                if (window._replayState.playing) stopReplay();
            }, 3000);
        }
    }

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
        btn.innerText = '📍 Drop Pin / Check-in'; btn.disabled = false;
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
        pt.isPrivate = document.getElementById('reg-wifi-private').checked;
        pt.connections = 1;
        wifiPoints.push(pt);
        savePoint(pt);
        renderMarkers();
        if (document.getElementById('stats-view').classList.contains('active')) updateCharts();
        map.setView([pt.lat, pt.lng], 14);
        document.getElementById('registration-modal').classList.add('hidden');
        await customAlert(`Saved: "${pt.ssid}"`);
        const btn = document.getElementById('register-btn');
        btn.innerText = '📍 Drop Pin / Check-in'; btn.disabled = false;
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

            point.isPrivate = document.getElementById('edit-wifi-private').checked;

            if (window._pendingDuplicateHistoryObj) {
                window._pendingDuplicateHistoryObj.note = document.getElementById('edit-wifi-note').value.trim();
                window._pendingDuplicateHistoryObj = null;
            } else {
                point.note = document.getElementById('edit-wifi-note').value.trim();
            }

            point.city = document.getElementById('edit-wifi-city').value.trim() || 'Unknown';
            point.country = document.getElementById('edit-wifi-country').value.trim() || 'Unknown';
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

    initActivityPolling();
}

function initActivityPolling() {
    let activityInterval = null;
    const pingActivity = () => {
        if (window.Android && window.Android.updateActivity) {
            window.Android.updateActivity();
        }
    };

    if (document.visibilityState === 'visible') {
        pingActivity();
        activityInterval = setInterval(pingActivity, 2 * 60 * 1000);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            pingActivity();
            if (!activityInterval) activityInterval = setInterval(pingActivity, 2 * 60 * 1000);
        } else {
            if (activityInterval) {
                clearInterval(activityInterval);
                activityInterval = null;
            }
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
    try {
        if (markerClusterGroup) {
            map.removeLayer(markerClusterGroup);
        }

        // Cluster markers to massively improve zoom out performance
        const density = parseInt(localStorage.getItem('clusterDensity') || '40', 10);

        if (density > 0) {
            markerClusterGroup = L.markerClusterGroup({
                maxClusterRadius: density,
                disableClusteringAtZoom: 15,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
                chunkedLoading: true
            });
        } else {
            markerClusterGroup = L.featureGroup();
        }

        markers = [];
        const scale = parseFloat(localStorage.getItem('markerSize') || '1.0');
        const w = 30 * scale;
        const h = 42 * scale;

        if (!window._hideMyPoints && typeof wifiPoints !== 'undefined' && Array.isArray(wifiPoints)) {
            wifiPoints.forEach(pt => {
                try {
                    if (!pt || pt.lat == null || pt.lng == null || isNaN(pt.lat) || isNaN(pt.lng)) return;

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
                    const dateStr = pt.dateAdded ? new Date(pt.dateAdded).toLocaleDateString('en-US') : 'Unknown';
                    const altStr = pt.altitude !== undefined && pt.altitude !== null ? pt.altitude : '0';
                    const homeIndicator = pt.isHome ? `<div style="background:#eab308;color:#fff;padding:2px 6px;border-radius:4px;font-size:0.7rem;display:inline-block;margin-bottom:4px;box-shadow:0 2px 4px rgba(0,0,0,0.2);">🏠 Home Location</div><br>` : '';

                    const popup = `<div class="custom-popup">
                        ${homeIndicator}
                        <b style="color:${mColor}">${pt.ssid || 'Unknown'}</b>
                        <p>📍 ${pt.city || 'Unknown'}, ${pt.country || ''}</p>
                        <p>📅 Added: ${dateStr}</p>
                        <p>🏔️ Altitude: ${altStr} m</p>
                        <p>🔗 Connections: ${pt.connections || 1}</p>
                        <p>📝 Note: ${pt.note || 'None'}</p>
                        <div style="display:flex;gap:6px;margin-top:8px;">
                            <button class="popup-btn" style="flex:1;background:var(--btn-hist-bg);color:var(--btn-hist-text);" onclick="window.viewHistory('${pt.id}')">History</button>
                            <button class="popup-btn" style="flex:1;background:${mColor};color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.5);" onclick="window.openEditModal('${pt.id}')">Edit</button>
                        </div>
                        <div style="display:flex;gap:6px;margin-top:6px;">
                            <button class="popup-btn popup-btn-play" style="flex:1;background:rgba(99,102,241,0.2);color:#818cf8;border:1px solid rgba(99,102,241,0.4);" onclick="window.startReplay('${pt.id}')">▶️ Play</button>
                            ${!pt.isHome ? `<button class="popup-btn popup-btn-home" style="flex:1;background:linear-gradient(135deg, #eab308, #d97706);color:#fff;font-weight:bold;" onclick="window.setAsHome('${pt.id}')">🏠 Set Home</button>` : ''}
                        </div>
                    </div>`;
                    const marker = L.marker([pt.lat, pt.lng], { icon }).bindPopup(popup, { minWidth: 220 });
                    markerClusterGroup.addLayer(marker);
                    markers.push(marker);
                } catch (e) {
                    console.error("Failed to render user point:", pt, e);
                }
            });
        }

        if (window.friendWifiPoints && Array.isArray(window.friendWifiPoints)) {
            window.friendWifiPoints.forEach(pt => {
                try {
                    if (!pt || pt.lat == null || pt.lng == null || isNaN(pt.lat) || isNaN(pt.lng)) return;

                    const ownerIdStr = String(pt.ownerId);
                    if (window.activeFriendFilters && !window.activeFriendFilters.has(ownerIdStr)) return;

                    const profile = window.lastFriendProfiles ? window.lastFriendProfiles[ownerIdStr] : null;
                    const displayName = profile && profile.displayName ? profile.displayName : 'Friend';
                    const photoUrl = profile && profile.photoUrl ? profile.photoUrl : 'https://ui-avatars.com/api/?name=F';
                    const accessLevel = profile && profile.accessLevel ? profile.accessLevel : 'full';

                    const html = `
                        <div style="width:16px; height:16px; background-color:var(--teal); border-radius:8px 8px 8px 0; transform:rotate(-45deg); border:1px solid #fff; box-shadow:0 0 5px var(--teal); position:relative;">
                            <div style="position:absolute; top:3px; right:3px; width:4px; height:4px; border-radius:50%; background:#10b981; border:1px solid #fff;"></div>
                        </div>
                    `;
                    const icon = L.divIcon({ className: '', html: html, iconSize: [20, 20], iconAnchor: [8, 20], popupAnchor: [0, -20] });

                    const mColor = pt.markerColor || '#14b8a6';
                    const dateStr = pt.dateAdded ? new Date(pt.dateAdded).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown';
                    const altStr = pt.altitude !== undefined && pt.altitude !== null ? pt.altitude : '0';
                    const locationStr = [pt.city, pt.country].filter(Boolean).join(', ') || 'Unknown';

                    let popupDetails = '';
                    if (accessLevel === 'full') {
                        popupDetails = `
                            <p>📍 ${locationStr}</p>
                            <p>📅 ${dateStr}</p>
                            <p>🏔️ Altitude: ${altStr} m</p>
                            <p>🔗 Connections: ${pt.connections || 1}</p>
                            <p>📝 Note: ${pt.note || 'None'}</p>
                            <div style="display:flex;gap:6px;margin-top:6px;">
                                <button class="popup-btn popup-btn-play" style="flex:1;background:rgba(99,102,241,0.2);color:#818cf8;border:1px solid rgba(99,102,241,0.4);" onclick="window.startReplay('${pt.id}')">▶️ Play</button>
                            </div>
                        `;
                    } else {
                        popupDetails = `<p>📍 ${locationStr}</p><div style="margin-top:4px; font-size:0.75rem; color:var(--slate-light);">Stats only access</div>`;
                    }

                    const popup = `<div class="custom-popup">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                            <img src="${photoUrl}" style="width:26px; height:26px; border-radius:50%; object-fit:cover; border:1px solid var(--teal);" onerror="this.src='https://ui-avatars.com/api/?name=F';">
                            <b style="color:var(--teal); font-size:0.95rem;">${displayName}</b>
                        </div>
                        <b style="font-size:1rem; color:var(--text-color);">${pt.ssid || 'Unknown'}</b>
                        ${popupDetails}
                    </div>`;
                    const marker = L.marker([pt.lat, pt.lng], { icon }).bindPopup(popup, { minWidth: 200 });
                    markerClusterGroup.addLayer(marker);
                    markers.push(marker);
                } catch (e) {
                    console.error("Failed to render friend point:", pt, e);
                }
            });
        }

        markerClusterGroup.addTo(map);
    } catch (e) {
        console.error("Error running renderMarkers()", e);
    }
}

window.viewHistory = function (id) {
    const pt = wifiPoints.find(p => String(p.id) === String(id));
    if (!pt) return;
    map.closePopup();

    let histHtml = `<div style="text-align:left; max-height:350px; overflow-y:auto; padding-right:4px;">`;

    const altStr = pt.altitude !== undefined && pt.altitude !== null ? pt.altitude : '0';
    histHtml += `
        <div style="background:var(--hist-bg); border-radius:8px; border:1px solid var(--hist-border); padding:10px; margin-bottom:8px;">
            <div style="color:var(--teal); font-weight:700; font-size:0.85rem; margin-bottom:4px; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <span>#1</span>
                    <span style="color:var(--slate-light); font-weight:500; font-size:0.8rem; margin-left:8px;">${new Date(Number(pt.dateAdded)).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <button onclick="window.editHistoryNote('${pt.id}', -1)" style="background:transparent; border:none; color:var(--teal); cursor:pointer; font-size:1.1rem; padding: 0;" title="Edit Note">✏️</button>
            </div>
            <div style="color:var(--slate-light); font-size:0.8rem;">Alt: ${altStr}m</div>
            ${pt.note ? `<div style="color:var(--text-main); font-size:0.8rem; margin-top:4px; word-wrap:break-word;">${pt.note}</div>` : ''}
        </div>
    `;

    if (pt.history && pt.history.length > 0) {
        pt.history.forEach((h, i) => {
            const hAlt = h.altitude !== undefined && h.altitude !== null ? h.altitude : '0';
            histHtml += `
                <div style="background:var(--hist-bg); border-radius:8px; border:1px solid var(--hist-border); padding:10px; margin-bottom:8px;">
                    <div style="color:var(--teal); font-weight:700; font-size:0.85rem; margin-bottom:4px; display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <span>#${i + 2} ${h.auto ? '⚡' : ''}</span>
                            <span style="color:var(--slate-light); font-weight:500; font-size:0.8rem; margin-left:8px;">${new Date(Number(h.date)).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        <div style="display:flex; gap:8px;">
                            <button onclick="window.editHistoryNote('${pt.id}', ${i})" style="background:transparent; border:none; color:var(--teal); cursor:pointer; font-size:1.1rem; padding: 0;" title="Edit Note">✏️</button>
                            <button onclick="window.deleteHistoryItem('${pt.id}', ${i})" style="background:transparent; border:none; color:var(--danger); cursor:pointer; font-size:1.1rem; padding: 0;" title="Delete record">🗑️</button>
                        </div>
                    </div>
                    <div style="color:var(--slate-light); font-size:0.8rem;">Alt: ${hAlt}m</div>
                    ${h.note ? `<div style="color:var(--text-main); font-size:0.8rem; margin-top:4px; word-wrap:break-word;">${h.note}</div>` : ''}
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

window.editHistoryNote = async function (ptId, historyIndex) {
    const pt = wifiPoints.find(p => String(p.id) === String(ptId));
    if (!pt) return;

    let currentNote = '';
    if (historyIndex === -1) {
        currentNote = pt.note || '';
    } else if (pt.history && pt.history.length > historyIndex) {
        currentNote = pt.history[historyIndex].note || '';
    }

    const newNote = await customPrompt('Edit note for this connection:', currentNote);

    if (newNote !== null) {
        const trimmed = newNote.trim();
        if (historyIndex === -1) {
            pt.note = trimmed;
        } else {
            pt.history[historyIndex].note = trimmed;
        }
        savePoint(pt);
        renderMarkers();
        if (document.getElementById('stats-view').classList.contains('active')) updateCharts();

        setTimeout(() => window.viewHistory(ptId), 100);
    } else {
        setTimeout(() => window.viewHistory(ptId), 100);
    }
};

window.deleteHistoryItem = async function (ptId, historyIndex) {
    if (await customConfirm('Are you sure you want to delete this specific connection record?')) {
        const pt = wifiPoints.find(p => String(p.id) === String(ptId));
        if (pt && pt.history && pt.history.length > historyIndex) {
            pt.history.splice(historyIndex, 1);
            pt.connections = Math.max(1, pt.connections - 1);
            savePoint(pt);
            renderMarkers();
            if (document.getElementById('stats-view').classList.contains('active')) {
                updateCharts();
            }
        }
    }
    // Re-open history modal (delay gives customConfirm time to clean up)
    setTimeout(() => {
        window.viewHistory(ptId);
    }, 50);
};

window.setAsHome = async function (id) {
    if (await customConfirm("Make this location your Home Base? This will be used to calculate your furthest discovery.")) {
        let changed = false;
        wifiPoints.forEach(p => {
            if (p.id === id) {
                p.isHome = true;
                savePoint(p);
                changed = true;
            } else if (p.isHome) {
                p.isHome = false;
                savePoint(p);
                changed = true;
            }
        });
        if (changed) {
            renderMarkers();
            if (typeof updateCharts === 'function') updateCharts();
        }
    }
};

window.openEditModal = function (id) {
    const point = wifiPoints.find(p => String(p.id) === String(id));
    if (!point) return;
    document.getElementById('edit-wifi-id').value = id;
    document.getElementById('edit-wifi-name').value = point.ssid;
    document.getElementById('edit-wifi-altitude').value = point.altitude !== undefined ? Math.round(point.altitude) : '';
    document.getElementById('edit-wifi-note').value = point.note || '';
    document.getElementById('edit-wifi-private').checked = !!point.isPrivate;
    document.getElementById('edit-wifi-city').value = point.city || '';
    document.getElementById('edit-wifi-country').value = point.country || '';
    setColor('edit-color-picker', point.markerColor || '#3b82f6');
    document.getElementById('edit-connections-info').innerText =
        `🔗 Connections: ${point.connections}`;
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
    if (charts.countries) charts.countries.destroy();
    if (charts.networkPie) charts.networkPie.destroy();

    charts.trend = new Chart(document.getElementById('trendChart').getContext('2d'), {
        type: 'line', data: { labels: [], datasets: [] },
        options: { responsive: true, tension: 0.3, plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
    charts.altitudeInfo = new Chart(document.getElementById('altitudeHistogramChart').getContext('2d'), {
        type: 'bar', data: { labels: [], datasets: [] },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, title: { display: true, text: 'Count' } },
                x: { title: { display: true, text: 'Altitude Ranges (m)' } }
            }
        }
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
        options: {
            indexAxis: 'y', responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, ticks: { precision: 0 } },
                y: { ticks: { autoSkip: false } }
            }
        }
    });
    charts.countries = new Chart(document.getElementById('countriesChart').getContext('2d'), {
        type: 'bar', data: { labels: [], datasets: [] },
        options: {
            indexAxis: 'y', responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, ticks: { precision: 0 } },
                y: { ticks: { autoSkip: false } }
            }
        }
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

    const topLocSelect = document.getElementById('top-locations-count');
    if (topLocSelect) topLocSelect.addEventListener('change', updateCharts);

    const topCountriesSelect = document.getElementById('top-countries-count');
    if (topCountriesSelect) topCountriesSelect.addEventListener('change', updateCharts);

    charts.networkPie = new Chart(document.getElementById('networkPieChart').getContext('2d'), {
        type: 'doughnut',
        data: { labels: ['Wi-Fi', 'Mobile Network'], datasets: [] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { color: Chart.defaults.color } } },
            cutout: '75%',
            elements: { arc: { borderWidth: 0 } }
        }
    });

    document.querySelectorAll('#network-pie-filters .chart-filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('#network-pie-filters .chart-filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            window._networkPieRange = e.target.getAttribute('data-range');
            updateNetworkPieChart();
        });
    });

    document.querySelectorAll('#heatmap-filters .chart-filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('#heatmap-filters .chart-filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            window._heatmapRange = e.target.getAttribute('data-range');
            updateHeatmap();
        });
    });
}

function getActivePoints() {
    try {
        let pts = [];
        if (!window._hideMyPoints && typeof wifiPoints !== 'undefined' && Array.isArray(wifiPoints)) {
            pts = pts.concat(wifiPoints);
        }
        if (window.friendWifiPoints && Array.isArray(window.friendWifiPoints)) {
            window.friendWifiPoints.forEach(p => {
                try {
                    const ownerIdStr = String(p.ownerId || '');
                    if (window.activeFriendFilters && window.activeFriendFilters.has(ownerIdStr)) {
                        pts.push(p);
                    }
                } catch (e) { }
            });
        }
        return pts;
    } catch (e) {
        console.error("getActivePoints error:", e);
        return typeof wifiPoints !== 'undefined' && Array.isArray(wifiPoints) ? wifiPoints : [];
    }
}

function updateCharts() {
    try {
        buildGlobalConnections();

        const pts = typeof getActivePoints === 'function' ? getActivePoints() : (typeof wifiPoints !== 'undefined' && Array.isArray(wifiPoints) ? wifiPoints : []);
        const totalConnections = pts.reduce((s, p) => s + (Number(p.connections) || 1), 0);
        document.getElementById('total-connections-val').innerText = totalConnections;
        document.getElementById('unique-connections-val').innerText = pts.length;

        const uniqueWifiCount = pts.filter(p => !p.networkType || p.networkType === 'wifi').length;
        const uiWifiVal = document.getElementById('unique-wifi-val');
        if (uiWifiVal) uiWifiVal.innerText = uniqueWifiCount;

        // Unique countries and cities
        const uniqueCountries = new Set(pts.map(p => p.country).filter(Boolean));
        const uniqueCities = new Set(pts.map(p => p.city).filter(Boolean));
        const countriesEl = document.getElementById('unique-countries-val');
        const citiesEl = document.getElementById('unique-cities-val');
        if (countriesEl) countriesEl.innerText = uniqueCountries.size;
        if (citiesEl) citiesEl.innerText = uniqueCities.size;

        // Furthest Discovery Logic
        const homeElVal = document.getElementById('furthest-point-val');
        const homeElDesc = document.getElementById('furthest-point-desc');
        if (homeElVal && homeElDesc && typeof wifiPoints !== 'undefined' && Array.isArray(wifiPoints)) {
            const homePoint = wifiPoints.find(p => p.isHome);
            if (homePoint && homePoint.lat != null && homePoint.lng != null) {
                let maxDist = 0;
                let furthestPt = null;
                pts.forEach(p => {
                    if (p.lat != null && p.lng != null) {
                        const dist = getDistance(homePoint.lat, homePoint.lng, p.lat, p.lng);
                        if (dist > maxDist) {
                            maxDist = dist;
                            furthestPt = p;
                        }
                    }
                });

                if (furthestPt && maxDist > 500) { // If distance > 500 meters
                    const km = Math.round(maxDist / 1000).toLocaleString();
                    homeElVal.innerText = `${km} km from Home`;
                    homeElDesc.innerHTML = `📍 ${furthestPt.city || 'Unknown'}${furthestPt.country ? ', ' + furthestPt.country : ''} &nbsp;&mdash;&nbsp; <b>${furthestPt.ssid || 'Unknown'}</b>`;
                } else {
                    homeElVal.innerText = `You are at Home!`;
                    homeElDesc.innerText = `Explore more to calculate your furthest discovery.`;
                }
            } else {
                homeElVal.innerText = 'No Home Set';
                homeElDesc.innerText = 'Tap any of your pins on the map to "Set as Home"';
            }
        }

        updateTrendChart();
        updateTimeline();
        updateAltitudeTimeChart();
        updateNetworkPieChart();
        updateHeatmap();

        // Altitude Statistics
        let altitudes = pts.map(p => p.altitude || 0).filter(a => typeof a === 'number');
        if (altitudes.length > 0) {
            altitudes.sort((a, b) => a - b);
            const min = Math.round(altitudes[0]);
            const max = Math.round(altitudes[altitudes.length - 1]);
            const avg = Math.round(altitudes.reduce((a, b) => a + b, 0) / altitudes.length);
            const median = altitudes.length % 2 === 0 ? (altitudes[altitudes.length / 2 - 1] + altitudes[altitudes.length / 2]) / 2 : altitudes[Math.floor(altitudes.length / 2)];
            document.getElementById('alt-min-val').innerText = min + 'm';
            document.getElementById('alt-max-val').innerText = max + 'm';
            document.getElementById('alt-avg-val').innerText = avg + 'm';
            const medianEl = document.getElementById('alt-median-val');
            if (medianEl) medianEl.innerText = Math.round(median) + 'm';

            // Build DYNAMIC Histogram — bins auto-scale to actual altitude range
            const BINS = 6;
            const binMin = Math.floor(min / 10) * 10;
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
                datasets: [{
                    data: trimmedCounts,
                    backgroundColor: '#3b82f6',
                    borderRadius: 2,
                    barPercentage: 1.0,
                    categoryPercentage: 1.0
                }]
            };
            charts.altitudeInfo.update();
        } else {
            document.getElementById('alt-min-val').innerText = '0m';
            document.getElementById('alt-max-val').innerText = '0m';
            document.getElementById('alt-avg-val').innerText = '0m';
            const medianEl = document.getElementById('alt-median-val');
            if (medianEl) medianEl.innerText = '0m';
            charts.altitudeInfo.data = { labels: ['No Data'], datasets: [{ data: [0] }] };
            charts.altitudeInfo.update();
        }

        // Top Locations — show UNIQUE networks per city (count of wifiPoints per city)
        const locChartSelect = document.getElementById('top-locations-count');
        const locChartLimit = locChartSelect ? parseInt(locChartSelect.value) : 5;

        const cityUnique = {};
        pts.forEach(p => { const k = `${p.city}, ${p.country}`; cityUnique[k] = (cityUnique[k] || 0) + 1; });
        const top5 = Object.entries(cityUnique).sort((a, b) => b[1] - a[1]).slice(0, locChartLimit);
        charts.places.data = {
            labels: top5.length ? top5.map(c => c[0]) : ['No data'],
            datasets: [{ label: 'Unique Networks', data: top5.map(c => c[1]), backgroundColor: '#0f766e', borderRadius: 4 }]
        };
        charts.places.update();

        // Top Countries — show UNIQUE networks per country
        const countryChartSelect = document.getElementById('top-countries-count');
        const countryChartLimit = countryChartSelect ? parseInt(countryChartSelect.value) : 5;

        const countryUnique = {};
        pts.forEach(p => { const k = p.country || 'Unknown'; countryUnique[k] = (countryUnique[k] || 0) + 1; });
        const topCountries = Object.entries(countryUnique).sort((a, b) => b[1] - a[1]).slice(0, countryChartLimit);
        charts.countries.data = {
            labels: topCountries.length ? topCountries.map(c => c[0]) : ['No data'],
            datasets: [{ label: 'Unique Networks', data: topCountries.map(c => c[1]), backgroundColor: '#3b82f6', borderRadius: 4 }]
        };
        charts.countries.update();

        populateTables();
    } catch (e) {
        console.error("updateCharts error:", e);
    }
}

function populateTables() {
    // LOCATIONS TABLE
    const locSelect = document.getElementById('locations-count-select');
    const locLimit = locSelect ? parseInt(locSelect.value) : 10;
    const locTbody = document.getElementById('recent-locations-tbody');
    if (locTbody) {
        locTbody.innerHTML = '';
        const pts = typeof getActivePoints === 'function' ? getActivePoints() : (typeof wifiPoints !== 'undefined' ? wifiPoints : []);
        const sortedPoints = [...pts].sort((a, b) => Number(b.dateAdded) - Number(a.dateAdded)).slice(0, locLimit);
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

    const pts = typeof getActivePoints === 'function' ? getActivePoints() : (window.wifiPoints || []);
    pts.forEach(pt => {
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
    const pts = typeof getActivePoints === 'function' ? getActivePoints() : (typeof wifiPoints !== 'undefined' ? wifiPoints : []);
    pts.forEach(pt => {
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
            networkType: pt.networkType || ((pt.ssid === 'Cellular Data') ? 'cellular' : 'wifi'),
            id: pt.id || '',
            city: pt.city || 'Unknown',
            country: pt.country || '',
            note: pt.note || '',
            latestNote,
            lastConnectionDate,
            lat: pt.lat,
            lng: pt.lng,
            markerColor: pt.markerColor
        });

        (pt.history || []).forEach(h => {
            connections.push({
                date: Number(h.date),
                altitude: h.altitude || 0,
                ssid: pt.ssid,
                networkType: pt.networkType || ((pt.ssid === 'Cellular Data') ? 'cellular' : 'wifi'),
                id: pt.id || '',
                city: pt.city || 'Unknown',
                country: pt.country || '',
                note: h.note || '',
                latestNote,
                lastConnectionDate,
                lat: pt.lat,
                lng: pt.lng,
                markerColor: pt.markerColor
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

    const minSpacing = 15;   // px tight baseline
    const maxSpacing = 120;   // px cap to avoid wide gaps

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

    let dataPoints = filtered;

    // Aggregation Logic (Downsampling)
    if (dataPoints.length > 30) {
        const bucketSizeMs = window._currentAltRange === '1D'
            ? 3600000 // 1 hour buckets
            : 86400000; // 1 day buckets

        const buckets = {};
        dataPoints.forEach(c => {
            const bucketKey = Math.floor(c.date / bucketSizeMs) * bucketSizeMs;
            if (!buckets[bucketKey]) buckets[bucketKey] = [];
            buckets[bucketKey].push(c.altitude || 0);
        });

        dataPoints = Object.keys(buckets).sort((a, b) => a - b).map(key => {
            const arr = buckets[key];
            const avgAlt = Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
            return {
                date: parseInt(key, 10),
                altitude: avgAlt
            };
        });
    }

    const labels = dataPoints.map(c => {
        const d = new Date(c.date);
        return window._currentAltRange === '1D'
            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    });

    const data = dataPoints.map(c => c.altitude || 0);

    charts.altitudeTime.data = {
        labels: labels.length ? labels : ['No data'],
        datasets: [{
            label: dataPoints.length !== filtered.length ? 'Altitude (m) - Averaged' : 'Altitude (m)',
            data: data.length ? data : [0],
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245,158,11,0.1)',
            fill: true,
            pointBackgroundColor: '#f59e0b',
            pointRadius: data.length > 20 ? 0 : 4,
            pointHitRadius: 10,
            pointHoverRadius: 6,
            tension: 0.4
        }]
    };
    charts.altitudeTime.options.plugins.legend.labels = { color: Chart.defaults.color };
    charts.altitudeTime.update();
}

function updateNetworkPieChart() {
    if (!charts.networkPie || !window._allConnections) return;
    if (!window._networkPieRange) window._networkPieRange = 'ALL';

    const cutoff = getCutoff(window._networkPieRange);
    const filtered = window._allConnections.filter(c => c.date >= cutoff);

    let wifiCount = 0;
    let mobileCount = 0;

    filtered.forEach(c => {
        let type = c.networkType;
        if (!type) {
            type = (c.ssid === 'Cellular Data') ? 'cellular' : 'wifi';
        }
        if (type === 'cellular') {
            mobileCount++;
        } else {
            wifiCount++;
        }
    });

    if (wifiCount === 0 && mobileCount === 0) {
        charts.networkPie.data = {
            labels: ['No Data'],
            datasets: [{ data: [1], backgroundColor: ['rgba(255,255,255,0.05)'] }]
        };
    } else {
        charts.networkPie.data = {
            labels: ['Wi-Fi', 'Mobile Network'],
            datasets: [{
                data: [wifiCount, mobileCount],
                backgroundColor: ['#14b8a6', '#6366f1'],
                hoverOffset: 4
            }]
        };
    }
    charts.networkPie.update();
}

function updateHeatmap() {
    if (!window._allConnections) return;
    if (!window._heatmapRange) window._heatmapRange = 'ALL';

    const cutoff = getCutoff(window._heatmapRange);
    const filtered = window._allConnections.filter(c => c.date >= cutoff);

    const counts = Array.from({ length: 7 }, () => Array(24).fill(0));
    let maxCount = 0;

    filtered.forEach(c => {
        const d = new Date(c.date);
        let day = d.getDay() - 1; // 0 is Monday, 6 is Sunday
        if (day === -1) day = 6;
        const hr = d.getHours();
        counts[day][hr]++;
        if (counts[day][hr] > maxCount) maxCount = counts[day][hr];
    });

    const container = document.getElementById('activityHeatmap');
    if (!container) return;

    let html = '';

    // Header row (Empty + 24 hours)
    html += `<div style="min-width: 30px;"></div>`;
    for (let h = 0; h < 24; h++) {
        html += `<div class="heatmap-hour-label">${h % 2 === 0 ? h : ''}</div>`;
    }

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const tooltipDayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    for (let d = 0; d < 7; d++) {
        html += `<div class="heatmap-day-label">${dayNames[d]}</div>`;
        for (let h = 0; h < 24; h++) {
            const count = counts[d][h];
            let opacity = 0.05;
            if (maxCount > 0 && count > 0) {
                // Scale opacity from 0.2 to 1.0 depending on value
                opacity = 0.2 + (count / maxCount) * 0.8;
            }

            let bg;
            if (count === 0) {
                bg = 'rgba(20, 184, 166, 0.05)';
            } else {
                bg = `rgba(20, 184, 166, ${opacity})`;
            }

            const timeRange = `${String(h).padStart(2, '0')}:00 - ${String(h + 1).padStart(2, '0')}:00`;
            const countText = count === 1 ? '1 connection' : `${count} connections`;

            html += `
                <div class="heatmap-cell" style="background: ${bg};">
                    <div class="tooltip">${tooltipDayNames[d]}<br>${timeRange}<br><b style="color:var(--teal)">${countText}</b></div>
                </div>
            `;
        }
    }

    container.innerHTML = html;
}

