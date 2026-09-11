/* =============================================================
 * Itinerary Planner - Offline PWA + Firebase sync
 * ============================================================= */

'use strict';

/* =============================================================
 * CONSTANTS
 * ============================================================= */
const DB_NAME = 'itinerary-planner';
const DB_VERSION = 2;
const STORE_TRIPS = 'trips';
const STORE_ACTIVITIES = 'activities';
const STORE_META = 'meta';

const CATEGORY_EMOJI = {
  food: '🍽️', sightseeing: '🏛️', adventure: '🎢',
  shopping: '🛍️', transport: '🚗', accommodation: '🏨', other: '📌',
};
const CATEGORY_LABEL = {
  food: 'Food', sightseeing: 'Sightseeing', adventure: 'Adventure',
  shopping: 'Shopping', transport: 'Transport', accommodation: 'Accommodation', other: 'Other',
};

const CURRENCY = 'MYR';
const CURRENCY_PREFIX = 'RM';

/* =============================================================
 * APP STATE
 * ============================================================= */
const state = {
  db: null,
  currentTripId: null,
  editingActivityId: null,
  editingTripId: null,
  currentView: 'trips',
  currentTab: 'schedule',
  user: null,
  firebaseReady: false,
  firestore: null,
  auth: null,
  unsubTrips: null,
  unsubActs: null,
  pickedCoord: null, // { lat, lng, address }
  pickedTripCoord: null,
  pickedTransportFromCoord: null,
  pickedTransportToCoord: null,
};

/* =============================================================
 * INDEXEDDB
 * ============================================================= */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_TRIPS)) {
        db.createObjectStore(STORE_TRIPS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_ACTIVITIES)) {
        const s = db.createObjectStore(STORE_ACTIVITIES, { keyPath: 'id' });
        s.createIndex('tripId', 'tripId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode = 'readonly') {
  return state.db.transaction(store, mode).objectStore(store);
}
function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* --- Trips --- */
async function getAllTrips() { return reqP(tx(STORE_TRIPS).getAll()); }
async function getTrip(id) { return reqP(tx(STORE_TRIPS).get(id)); }
async function saveTrip(trip) {
  trip.updatedAt = Date.now();
  await reqP(tx(STORE_TRIPS, 'readwrite').put(trip));
  if (state.user && !trip._fromCloud) syncTripUp(trip);
  return trip;
}
async function deleteTripDB(id) {
  await reqP(tx(STORE_TRIPS, 'readwrite').delete(id));
  const acts = await getActivitiesByTrip(id);
  const store = tx(STORE_ACTIVITIES, 'readwrite');
  await Promise.all(acts.map(a => reqP(store.delete(a.id))));
  if (state.user) deleteTripCloud(id);
}

/* --- Activities --- */
async function getActivitiesByTrip(tripId) {
  return new Promise((resolve, reject) => {
    const store = tx(STORE_ACTIVITIES);
    const idx = store.index('tripId');
    const req = idx.getAll(tripId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function getActivity(id) { return reqP(tx(STORE_ACTIVITIES).get(id)); }
async function saveActivity(a) {
  a.updatedAt = Date.now();
  await reqP(tx(STORE_ACTIVITIES, 'readwrite').put(a));
  if (state.user && !a._fromCloud) syncActivityUp(a);
  return a;
}
async function deleteActivityDB(id) {
  const a = await getActivity(id);
  await reqP(tx(STORE_ACTIVITIES, 'readwrite').delete(id));
  if (state.user && a) deleteActivityCloud(a.tripId, id);
}

/* =============================================================
 * FIREBASE INIT
 * ============================================================= */
function isFirebaseConfigured() {
  const c = window.FIREBASE_CONFIG;
  return !!(c && c.apiKey && c.apiKey !== 'PASTE_API_KEY_HERE' && c.projectId && c.authDomain);
}

async function initFirebase() {
  if (!isFirebaseConfigured()) {
    document.getElementById('config-banner').classList.remove('hidden');
    document.getElementById('signin-prompt').classList.add('hidden');
    document.getElementById('auth-chip').classList.add('hidden');
    return;
  }
  document.getElementById('config-banner').classList.add('hidden');

  try {
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    state.auth = firebase.auth();
    state.firestore = firebase.firestore();
    // Enable IndexedDB persistence for offline writes
    try {
      await state.firestore.enablePersistence({ synchronizeTabs: true });
    } catch (err) {
      // Non-fatal: multi-tab or private mode
      console.warn('Firestore persistence unavailable:', err && err.code);
    }
    state.firebaseReady = true;

    state.auth.onAuthStateChanged(handleAuthChange);
  } catch (err) {
    console.error('Firebase init failed:', err);
    toast('Cloud sync unavailable — running locally.', 'error');
  }
}

function handleAuthChange(user) {
  state.user = user || null;
  updateAuthUI();

  if (user) {
    // Start cloud sync
    startCloudSync();
    // Push any local trips that don't have ownerUid
    migrateLocalToCloud();
  } else {
    stopCloudSync();
  }

  renderTripsList();
  if (state.currentTripId) renderTripDetail();
}

function updateAuthUI() {
  const chip = document.getElementById('auth-chip');
  const dot = document.getElementById('sync-dot');
  const avatar = document.getElementById('auth-avatar');
  const label = document.getElementById('auth-label');
  const prompt = document.getElementById('signin-prompt');

  if (!isFirebaseConfigured()) {
    chip.classList.add('hidden');
    prompt.classList.add('hidden');
    return;
  }

  chip.classList.remove('hidden');

  if (state.user) {
    prompt.classList.add('hidden');
    dot.classList.remove('offline');
    dot.title = 'Signed in — syncing';
    const initials = (state.user.displayName || state.user.email || '?')
      .split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
    if (state.user.photoURL) {
      avatar.innerHTML = `<img src="${state.user.photoURL}" alt="" referrerpolicy="no-referrer" />`;
    } else {
      avatar.textContent = initials;
    }
    label.textContent = 'Sign out';
  } else {
    prompt.classList.remove('hidden');
    dot.classList.add('offline');
    dot.title = 'Signed out — local only';
    avatar.textContent = '?';
    label.textContent = 'Sign in';
  }
}

async function signIn() {
  if (!state.firebaseReady) return;
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await state.auth.signInWithPopup(provider);
    toast('Signed in', 'success');
  } catch (err) {
    console.error(err);
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
      try {
        await state.auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider());
      } catch (e) { toast('Sign-in failed: ' + e.message, 'error'); }
    } else {
      toast('Sign-in failed: ' + err.message, 'error');
    }
  }
}
async function signOut() {
  await state.auth.signOut();
  toast('Signed out', 'success');
}

/* =============================================================
 * CLOUD SYNC (Firestore)
 * Doc layout:
 *   users/{uid}/trips/{tripId}
 *   users/{uid}/trips/{tripId}/activities/{activityId}
 * ============================================================= */
function userTripsCol() {
  return state.firestore.collection('users').doc(state.user.uid).collection('trips');
}
function userActsCol(tripId) {
  return userTripsCol().doc(String(tripId)).collection('activities');
}

function startCloudSync() {
  if (!state.user) return;
  stopCloudSync();

  // Listen to trips
  state.unsubTrips = userTripsCol().onSnapshot(async snap => {
    const changes = snap.docChanges();
    for (const ch of changes) {
      const data = ch.doc.data();
      data.id = Number(ch.doc.id);
      if (ch.type === 'removed') {
        const local = await getTrip(data.id);
        if (local) await reqP(tx(STORE_TRIPS, 'readwrite').delete(data.id));
      } else {
        // Apply if newer than local
        const local = await getTrip(data.id);
        if (!local || (data.updatedAt || 0) >= (local.updatedAt || 0)) {
          data._fromCloud = true;
          await reqP(tx(STORE_TRIPS, 'readwrite').put(data));
          delete data._fromCloud;
        }
      }
    }
    renderTripsList();
    if (state.currentTripId) renderTripDetail();
    // Kick off per-trip activity listeners
    subscribeToAllTripActivities();
  }, err => {
    console.warn('Trip sync error:', err);
  });
}
function stopCloudSync() {
  if (state.unsubTrips) { state.unsubTrips(); state.unsubTrips = null; }
  if (state.unsubActs) {
    Object.values(state.unsubActs).forEach(fn => fn && fn());
    state.unsubActs = null;
  }
}
async function subscribeToAllTripActivities() {
  if (!state.user) return;
  if (!state.unsubActs) state.unsubActs = {};
  const trips = await getAllTrips();
  const wanted = new Set(trips.map(t => String(t.id)));
  // Unsubscribe stale
  Object.keys(state.unsubActs).forEach(id => {
    if (!wanted.has(id)) { state.unsubActs[id](); delete state.unsubActs[id]; }
  });
  // Subscribe new
  for (const t of trips) {
    const key = String(t.id);
    if (state.unsubActs[key]) continue;
    state.unsubActs[key] = userActsCol(t.id).onSnapshot(async snap => {
      for (const ch of snap.docChanges()) {
        const data = ch.doc.data();
        data.id = Number(ch.doc.id);
        data.tripId = t.id;
        if (ch.type === 'removed') {
          await reqP(tx(STORE_ACTIVITIES, 'readwrite').delete(data.id));
        } else {
          const local = await getActivity(data.id);
          if (!local || (data.updatedAt || 0) >= (local.updatedAt || 0)) {
            data._fromCloud = true;
            await reqP(tx(STORE_ACTIVITIES, 'readwrite').put(data));
            delete data._fromCloud;
          }
        }
      }
      if (state.currentTripId === t.id) renderTripDetail();
      renderTripsList();
    });
  }
}

async function syncTripUp(trip) {
  if (!state.user) return;
  try {
    const clean = { ...trip };
    delete clean._fromCloud;
    clean.ownerUid = state.user.uid;
    await userTripsCol().doc(String(trip.id)).set(clean, { merge: true });
  } catch (err) { console.warn('Trip upload failed:', err); }
}
async function deleteTripCloud(id) {
  if (!state.user) return;
  try {
    // Delete activities first
    const snap = await userActsCol(id).get();
    const batch = state.firestore.batch();
    snap.forEach(d => batch.delete(d.ref));
    batch.delete(userTripsCol().doc(String(id)));
    await batch.commit();
  } catch (err) { console.warn('Trip cloud delete failed:', err); }
}
async function syncActivityUp(a) {
  if (!state.user) return;
  try {
    const clean = { ...a };
    delete clean._fromCloud;
    await userActsCol(a.tripId).doc(String(a.id)).set(clean, { merge: true });
  } catch (err) { console.warn('Activity upload failed:', err); }
}
async function deleteActivityCloud(tripId, actId) {
  if (!state.user) return;
  try { await userActsCol(tripId).doc(String(actId)).delete(); }
  catch (err) { console.warn('Activity cloud delete failed:', err); }
}

async function migrateLocalToCloud() {
  if (!state.user) return;
  const trips = await getAllTrips();
  for (const t of trips) {
    if (!t.ownerUid) {
      t.ownerUid = state.user.uid;
      await reqP(tx(STORE_TRIPS, 'readwrite').put(t));
      await syncTripUp(t);
      const acts = await getActivitiesByTrip(t.id);
      for (const a of acts) await syncActivityUp(a);
    }
  }
}

/* =============================================================
 * UTILITIES
 * ============================================================= */
function newId() { return Date.now() + Math.floor(Math.random() * 1000); }
function fmtMoney(n) {
  const v = Number(n) || 0;
  // Format with thousand separators, 2 decimals when needed
  const hasFrac = Math.abs(v - Math.round(v)) > 0.005;
  const opts = hasFrac
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { minimumFractionDigits: 0, maximumFractionDigits: 0 };
  return CURRENCY_PREFIX + ' ' + v.toLocaleString(undefined, opts);
}
function fmtDuration(min) {
  const m = Number(min) || 0;
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
function parseYMD(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function addDaysLabel(dateStr, days) {
  if (!dateStr) return '';
  const dt = parseYMD(dateStr);
  dt.setDate(dt.getDate() + days);
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtDateRange(startDate, days) {
  if (!startDate) return '';
  const start = addDaysLabel(startDate, 0);
  if (days <= 1) return start;
  return `${start} → ${addDaysLabel(startDate, days - 1)}`;
}
function addMinutesToTime(time, mins) {
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return '';
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + (Number(mins) || 0);
  const nh = Math.floor((total % (24 * 60)) / 60);
  const nm = total % 60;
  return String(nh).padStart(2, '0') + ':' + String(nm).padStart(2, '0');
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* =============================================================
 * THEME
 * ============================================================= */
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  updateThemeIcon();
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  setTheme(cur === 'dark' ? 'light' : 'dark');
}
function updateThemeIcon() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.querySelector('.theme-icon-light').classList.toggle('hidden', isDark);
  document.querySelector('.theme-icon-dark').classList.toggle('hidden', !isDark);
}

/* =============================================================
 * VIEW SWITCHING
 * ============================================================= */
function switchView(view) {
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');

  const backBtn = document.getElementById('back-btn');
  const title = document.getElementById('header-title');

  if (view === 'trips') {
    backBtn.classList.add('hidden');
    title.textContent = 'Itinerary';
  } else if (view === 'trip-detail') {
    backBtn.classList.remove('hidden');
    title.textContent = 'Trip';
  } else if (view === 'activity-form') {
    backBtn.classList.remove('hidden');
    title.textContent = state.editingActivityId ? 'Edit Activity' : 'New Activity';
  }

  window.scrollTo({ top: 0, behavior: 'auto' });
}

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('tab-schedule').classList.toggle('hidden', tab !== 'schedule');
  document.getElementById('tab-map').classList.toggle('hidden', tab !== 'map');
  if (tab === 'map') renderTripMap();
}

/* =============================================================
 * RENDER: TRIPS LIST
 * ============================================================= */
async function renderTripsList() {
  const trips = await getAllTrips();
  trips.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const grid = document.getElementById('trips-grid');
  const empty = document.getElementById('trips-empty');

  if (!trips.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const cards = await Promise.all(trips.map(async trip => {
    const acts = await getActivitiesByTrip(trip.id);
    const totalCost = acts.reduce((s, a) => s + (Number(a.cost) || 0), 0);
    const budgetPill = trip.budget
      ? `<span class="pill ${totalCost > trip.budget ? 'danger' : (totalCost / trip.budget > 0.85 ? 'warning' : 'accent')}">${fmtMoney(totalCost)} / ${fmtMoney(trip.budget)}</span>`
      : `<span class="pill accent">${fmtMoney(totalCost)}</span>`;
    return `
      <div class="trip-card" data-trip-id="${trip.id}">
        <h3>${escapeHtml(trip.name)}</h3>
        <div class="trip-meta">${escapeHtml(fmtDateRange(trip.startDate, trip.days))}</div>
        <div class="trip-stats">
          <span class="pill">${trip.days} day${trip.days === 1 ? '' : 's'}</span>
          <span class="pill">${acts.length} activit${acts.length === 1 ? 'y' : 'ies'}</span>
          ${budgetPill}
        </div>
      </div>`;
  }));
  grid.innerHTML = cards.join('');

  grid.querySelectorAll('.trip-card').forEach(card => {
    card.addEventListener('click', () => openTrip(Number(card.dataset.tripId)));
  });
}

/* =============================================================
 * RENDER: TRIP DETAIL
 * ============================================================= */
async function openTrip(tripId) {
  state.currentTripId = tripId;
  state.currentTab = 'schedule';
  await renderTripDetail();
  switchView('trip-detail');
  switchTab('schedule');
  renderWeather();
}

async function renderTripDetail() {
  const trip = await getTrip(state.currentTripId);
  if (!trip) {
    switchView('trips');
    return;
  }
  const acts = await getActivitiesByTrip(trip.id);
  const totalCost = acts.reduce((s, a) => s + (Number(a.cost) || 0), 0);

  document.getElementById('trip-detail-name').textContent = trip.name;
  document.getElementById('trip-detail-dates').textContent = fmtDateRange(trip.startDate, trip.days);
  document.getElementById('stat-cost').textContent = fmtMoney(totalCost);
  document.getElementById('stat-days').textContent = trip.days;
  document.getElementById('stat-activities').textContent = acts.length;

  // Budget
  const budget = Number(trip.budget) || 0;
  const budgetVal = document.getElementById('stat-budget');
  const budgetSub = document.getElementById('stat-budget-sub');
  const barWrap = document.getElementById('budget-bar-wrap');
  const fill = document.getElementById('budget-fill');
  if (budget > 0) {
    budgetVal.textContent = fmtMoney(budget);
    const pct = Math.min(200, Math.round((totalCost / budget) * 100));
    fill.style.width = Math.min(pct, 100) + '%';
    fill.className = 'fill' + (pct > 100 ? ' over' : pct > 85 ? ' warn' : '');
    barWrap.classList.remove('hidden');
    const remaining = budget - totalCost;
    budgetSub.textContent = pct <= 100
      ? `${pct}% used · ${fmtMoney(remaining)} left`
      : `Over by ${fmtMoney(Math.abs(remaining))}`;
  } else {
    budgetVal.textContent = '—';
    budgetSub.textContent = 'No budget set';
    barWrap.classList.add('hidden');
  }

  // Cost sub — avg per day
  document.getElementById('stat-cost-sub').textContent = trip.days
    ? `${fmtMoney(totalCost / trip.days)}/day avg` : '';

  renderSchedule(trip, acts);
  if (state.currentTab === 'map') renderTripMap();
}

function renderSchedule(trip, activities) {
  const container = document.getElementById('schedule');

  activities.sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    return (a.time || '').localeCompare(b.time || '');
  });

  const byDay = {};
  for (let d = 1; d <= trip.days; d++) byDay[d] = [];
  activities.forEach(a => {
    if (a.day >= 1 && a.day <= trip.days) byDay[a.day].push(a);
  });

  const html = Object.keys(byDay).map(d => {
    const dayNum = Number(d);
    const acts = byDay[d];
    const dayCost = acts.reduce((s, a) => s + (Number(a.cost) || 0), 0);
    const dateLabel = trip.startDate ? addDaysLabel(trip.startDate, dayNum - 1) : '';
    const hasCoords = dayHasCoords(activities, dayNum);

    // Split accommodations from other activities
    const stays = acts.filter(a => a.category === 'accommodation');
    const others = acts.filter(a => a.category !== 'accommodation');

    let inner = '';
    if (stays.length) {
      inner += `<div class="day-section-label">🏨 Stay</div>`;
      inner += stays.map(a => renderAccommodation(a)).join('');
    }

    if (!others.length && !stays.length) {
      inner = `
        <div class="no-activities">
          <div>Nothing planned for this day</div>
          <button class="btn btn-sm btn-primary" data-action="add-day" data-day="${dayNum}">+ Add activity</button>
        </div>`;
    } else if (others.length) {
      inner += `<div class="day-section-label">Schedule</div>`;
      inner += others.map(a => renderActivity(a)).join('');
    } else if (!others.length && stays.length) {
      inner += `
        <div class="no-activities">
          <div>No activities scheduled for this day</div>
          <button class="btn btn-sm btn-primary" data-action="add-day" data-day="${dayNum}">+ Add activity</button>
        </div>`;
    }

    const mapId = `day-map-${dayNum}`;

    return `
      <div class="day-block" data-day="${dayNum}">
        <div class="day-header">
          <h3><span class="day-num">${dayNum}</span> ${escapeHtml(dateLabel || 'Day ' + dayNum)}</h3>
          <div class="day-actions">
            <span class="day-cost">${fmtMoney(dayCost)}</span>
            ${hasCoords ? `<button class="btn btn-sm btn-ghost" data-action="toggle-map" data-day="${dayNum}">📍 Map</button>` : ''}
          </div>
        </div>
        <div class="activity-list">${inner}</div>
        <div class="map-container hidden" id="${mapId}" data-day-map="${dayNum}"></div>
      </div>`;
  }).join('');

  container.innerHTML = html;

  // Wire buttons
  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'add-day') return openActivityForm(null, Number(btn.dataset.day));
      if (action === 'toggle-map') return toggleDayMap(Number(btn.dataset.day));
      const id = Number(btn.dataset.id);
      if (action === 'edit') return openActivityForm(id);
      if (action === 'delete') return handleDeleteActivity(id);
      if (action === 'toggle') return handleToggleComplete(id);
    });
  });
}

function renderActivity(a) {
  const emoji = CATEGORY_EMOJI[a.category] || '📌';
  const endTime = a.time && a.duration ? addMinutesToTime(a.time, a.duration) : '';
  const metaParts = [];
  if (a.duration) metaParts.push(`<span title="Duration">⏱ ${fmtDuration(a.duration)}</span>`);
  if (Number(a.cost) > 0) metaParts.push(`<span title="Cost">💵 ${fmtMoney(a.cost)}</span>`);
  if (Number(a.travelTime) > 0) metaParts.push(`<span title="Travel to next">🚶 +${fmtDuration(a.travelTime)}</span>`);
  if (a.location) metaParts.push(`<span title="Location">📍 ${escapeHtml(a.location)}</span>`);
  if (Number.isFinite(a.lat) && Number.isFinite(a.lng)) {
    metaParts.push(`<span class="coord-badge" title="Pinned">◉ Pinned</span>`);
  }

  // Transport block
  let transportHtml = '';
  if (a.category === 'transport' && (a.transportRef || a.transportCarrier || a.transportFrom || a.transportTo)) {
    const items = [];
    if (a.transportRef) items.push(`<div class="tp-item"><span class="tp-label">Ref</span><span class="tp-value">${escapeHtml(a.transportRef)}</span></div>`);
    if (a.transportCarrier) items.push(`<div class="tp-item"><span class="tp-label">Carrier</span><span class="tp-value">${escapeHtml(a.transportCarrier)}</span></div>`);
    if (a.transportFrom || a.transportTo) {
      items.push(`<div class="tp-item" style="flex:1;min-width:180px"><span class="tp-label">Route</span><span class="tp-route">${escapeHtml(a.transportFrom || '?')} <span class="arrow">→</span> ${escapeHtml(a.transportTo || '?')}</span></div>`);
    }
    const hasDestCoord = Number.isFinite(a.transportToLat) && Number.isFinite(a.transportToLng);
    if (hasDestCoord) items.push(`<div class="tp-item"><span class="tp-label">Dest Pin</span><span class="tp-value">◉ ${a.transportToLat.toFixed(3)}, ${a.transportToLng.toFixed(3)}</span></div>`);
    transportHtml = `<div class="transport-block">${items.join('')}</div>`;
  }

  return `
    <div class="activity ${a.completed ? 'completed' : ''}" data-id="${a.id}">
      <div class="activity-time">
        ${escapeHtml(a.time || '--:--')}
        ${endTime ? `<span class="end-time">→ ${endTime}</span>` : ''}
      </div>
      <div class="activity-body">
        <div class="activity-name"><span class="cat-emoji" aria-hidden="true">${emoji}</span> ${escapeHtml(a.name)}</div>
        ${a.description ? `<div class="activity-desc">${escapeHtml(a.description)}</div>` : ''}
        ${metaParts.length ? `<div class="activity-meta">${metaParts.join('')}</div>` : ''}
        ${transportHtml}
      </div>
      <div class="activity-actions">
        <button class="btn btn-sm btn-ghost" data-action="toggle" data-id="${a.id}" title="${a.completed ? 'Undo' : 'Mark done'}">${a.completed ? '↺' : '✓'}</button>
        <button class="btn btn-sm btn-ghost" data-action="edit" data-id="${a.id}" title="Edit">✎</button>
        <button class="btn btn-sm btn-danger-ghost" data-action="delete" data-id="${a.id}" title="Delete" aria-label="Delete">✕</button>
      </div>
    </div>`;
}

function renderAccommodation(a) {
  const metaItems = [];
  if (a.acCheckIn) metaItems.push(`<div class="ac-item"><span class="ac-label">Check-in</span><span class="ac-value">${escapeHtml(a.acCheckIn)}</span></div>`);
  if (a.acCheckOut) metaItems.push(`<div class="ac-item"><span class="ac-label">Check-out</span><span class="ac-value">${escapeHtml(a.acCheckOut)}</span></div>`);
  if (a.acNights) metaItems.push(`<div class="ac-item"><span class="ac-label">Nights</span><span class="ac-value">${escapeHtml(a.acNights)}</span></div>`);
  if (a.acConfirmation) metaItems.push(`<div class="ac-item"><span class="ac-label">Booking #</span><span class="ac-value">${escapeHtml(a.acConfirmation)}</span></div>`);
  if (a.acContact) metaItems.push(`<div class="ac-item"><span class="ac-label">Contact</span><span class="ac-value">${escapeHtml(a.acContact)}</span></div>`);
  if (Number(a.cost) > 0) metaItems.push(`<div class="ac-item"><span class="ac-label">Cost</span><span class="ac-value">${fmtMoney(a.cost)}</span></div>`);

  const address = a.acAddress || a.location || '';
  const hasCoord = Number.isFinite(a.lat) && Number.isFinite(a.lng);

  return `
    <div class="accommodation-card ${a.completed ? 'completed' : ''}" data-id="${a.id}">
      <div class="ac-icon" aria-hidden="true">🏨</div>
      <div class="ac-body">
        <div class="ac-head">
          <span class="ac-name">${escapeHtml(a.name)}</span>
          <span class="ac-tag">Accommodation</span>
          ${hasCoord ? `<span class="ac-tag" style="color:var(--accent);background:transparent;padding-left:0">◉ Pinned</span>` : ''}
        </div>
        ${address ? `<div class="ac-address">📍 ${escapeHtml(address)}</div>` : ''}
        ${a.description ? `<div class="ac-address">${escapeHtml(a.description)}</div>` : ''}
        ${metaItems.length ? `<div class="ac-meta">${metaItems.join('')}</div>` : ''}
      </div>
      <div class="ac-actions">
        <button class="btn btn-sm btn-ghost" data-action="edit" data-id="${a.id}" title="Edit">✎</button>
        <button class="btn btn-sm btn-danger-ghost" data-action="delete" data-id="${a.id}" title="Delete" aria-label="Delete">✕</button>
      </div>
    </div>`;
}

/**
 * Expand each activity into 1 or 2 map points. Transport activities with a
 * destination coord contribute both origin and destination in time order.
 */
function activityToMapPoints(a, dayLabel) {
  const pts = [];
  const timeLabel = dayLabel ? `${dayLabel} · ${a.time || ''}` : (a.time || '');
  if (Number.isFinite(a.lat) && Number.isFinite(a.lng)) {
    const isTransport = a.category === 'transport';
    pts.push({
      lat: a.lat, lng: a.lng,
      name: isTransport && a.transportFrom ? `${a.name} — from ${a.transportFrom}` : a.name,
      time: timeLabel,
      location: a.location,
    });
  }
  if (a.category === 'transport' && Number.isFinite(a.transportToLat) && Number.isFinite(a.transportToLng)) {
    pts.push({
      lat: a.transportToLat, lng: a.transportToLng,
      name: a.transportTo ? `${a.name} — to ${a.transportTo}` : `${a.name} — destination`,
      time: timeLabel,
      location: a.transportTo || '',
    });
  }
  return pts;
}

async function toggleDayMap(day) {
  const container = document.querySelector(`#day-map-${day}`);
  if (!container) return;
  const wasHidden = container.classList.contains('hidden');
  container.classList.toggle('hidden');
  if (wasHidden) {
    const trip = await getTrip(state.currentTripId);
    const acts = await getActivitiesByTrip(trip.id);
    const dayActs = acts.filter(a => a.day === day)
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const pts = [];
    dayActs.forEach(a => activityToMapPoints(a).forEach(p => pts.push(p)));
    window.MapMod.renderMap(container, pts, { scrollWheelZoom: false });
  }
}

async function renderTripMap() {
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  const acts = await getActivitiesByTrip(trip.id);
  const sorted = [...acts].sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    return (a.time || '').localeCompare(b.time || '');
  });
  const pts = [];
  sorted.forEach(a => activityToMapPoints(a, `Day ${a.day}`).forEach(p => pts.push(p)));

  const container = document.getElementById('trip-map');
  const empty = document.getElementById('trip-map-empty');

  if (!pts.length) {
    empty.classList.remove('hidden');
    container.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  window.MapMod.renderMap(container, pts);
}

/** Any coords anywhere on this day (for the "Map" toggle visibility). */
function dayHasCoords(acts, day) {
  return acts.some(a => {
    if (a.day !== day) return false;
    if (Number.isFinite(a.lat) && Number.isFinite(a.lng)) return true;
    if (a.category === 'transport' && Number.isFinite(a.transportToLat) && Number.isFinite(a.transportToLng)) return true;
    return false;
  });
}

async function renderWeather() {
  const trip = await getTrip(state.currentTripId);
  const strip = document.getElementById('weather-strip');
  if (!trip) { strip.classList.add('hidden'); return; }

  // Prefer trip-level coords; else use first activity with coords
  let lat = trip.lat, lng = trip.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const acts = await getActivitiesByTrip(trip.id);
    const first = acts.find(a => Number.isFinite(a.lat) && Number.isFinite(a.lng));
    if (first) { lat = first.lat; lng = first.lng; }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    strip.classList.add('hidden');
    return;
  }

  const forecast = await window.Weather.fetchForecast(lat, lng, trip.startDate, trip.days);
  window.Weather.renderWeatherStrip(strip, forecast, trip.startDate);
}

/* =============================================================
 * TRIP FORM (MODAL)
 * ============================================================= */
function openTripModal(tripId = null) {
  state.editingTripId = tripId;
  state.pickedTripCoord = null;
  const modal = document.getElementById('trip-modal');
  const title = document.getElementById('trip-modal-title');
  const form = document.getElementById('trip-form');
  form.reset();

  if (tripId) {
    title.textContent = 'Edit Trip';
    getTrip(tripId).then(trip => {
      if (!trip) return;
      document.getElementById('tf-name').value = trip.name || '';
      document.getElementById('tf-start').value = trip.startDate || '';
      document.getElementById('tf-days').value = trip.days || 1;
      document.getElementById('tf-budget').value = trip.budget || '';
      document.getElementById('tf-description').value = trip.description || '';
      document.getElementById('tf-location').value = trip.locationName || '';
      if (Number.isFinite(trip.lat) && Number.isFinite(trip.lng)) {
        state.pickedTripCoord = { lat: trip.lat, lng: trip.lng, address: trip.locationName || '' };
      }
    });
  } else {
    title.textContent = 'New Trip';
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('tf-start').value = today;
    document.getElementById('tf-days').value = 3;
  }
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('tf-name').focus(), 60);
}
function closeTripModal() {
  document.getElementById('trip-modal').classList.add('hidden');
  state.editingTripId = null;
  state.pickedTripCoord = null;
  document.getElementById('trip-location-results').classList.add('hidden');
}

async function handleTripFormSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('tf-name').value.trim();
  const startDate = document.getElementById('tf-start').value;
  const days = parseInt(document.getElementById('tf-days').value, 10);
  const description = document.getElementById('tf-description').value.trim();
  const budget = parseFloat(document.getElementById('tf-budget').value) || 0;
  const locationName = document.getElementById('tf-location').value.trim();

  if (!name || !startDate || !days || days < 1) {
    toast('Please fill all required fields', 'error');
    return;
  }

  let lat = null, lng = null;
  if (state.pickedTripCoord) {
    lat = state.pickedTripCoord.lat;
    lng = state.pickedTripCoord.lng;
  } else if (locationName) {
    // Best-effort geocode
    try {
      const res = await window.MapMod.geocode(locationName, 1);
      if (res.length) { lat = res[0].lat; lng = res[0].lng; }
    } catch (e) {}
  }

  if (state.editingTripId) {
    const existing = await getTrip(state.editingTripId);
    await saveTrip({
      ...existing,
      name, startDate, days, description, budget, locationName,
      lat: Number.isFinite(lat) ? lat : existing.lat || null,
      lng: Number.isFinite(lng) ? lng : existing.lng || null,
    });
    toast('Trip updated', 'success');
    if (state.currentView === 'trip-detail') { await renderTripDetail(); renderWeather(); }
  } else {
    await saveTrip({
      id: newId(), name, startDate, days, description, budget, locationName,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      completed: false, createdAt: Date.now(),
      ownerUid: state.user ? state.user.uid : null,
    });
    toast('Trip created', 'success');
  }

  closeTripModal();
  await renderTripsList();
}

/* =============================================================
 * PDF EXPORT
 * ============================================================= */
async function handleExportPDF() {
  if (!state.currentTripId) return;
  if (typeof html2pdf === 'undefined') {
    toast('PDF library not loaded — check internet', 'error');
    return;
  }
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  const acts = await getActivitiesByTrip(trip.id);
  const totalCost = acts.reduce((s, a) => s + (Number(a.cost) || 0), 0);

  // Sort
  acts.sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    return (a.time || '').localeCompare(b.time || '');
  });

  const byDay = {};
  for (let d = 1; d <= trip.days; d++) byDay[d] = [];
  acts.forEach(a => { if (a.day >= 1 && a.day <= trip.days) byDay[a.day].push(a); });

  const dayHtml = Object.keys(byDay).map(d => {
    const dayNum = Number(d);
    const dActs = byDay[d];
    const stays = dActs.filter(a => a.category === 'accommodation');
    const others = dActs.filter(a => a.category !== 'accommodation');
    const dayCost = dActs.reduce((s, a) => s + (Number(a.cost) || 0), 0);
    const dateLabel = trip.startDate ? addDaysLabel(trip.startDate, dayNum - 1) : '';

    let staysHtml = '';
    if (stays.length) {
      staysHtml = `<div class="pdf-section-label">Stay</div>` + stays.map(a => `
        <div class="pdf-stay">
          <div class="pdf-stay-name">🏨 ${escapeHtml(a.name)}</div>
          ${(a.acAddress || a.location) ? `<div class="pdf-stay-addr">${escapeHtml(a.acAddress || a.location)}</div>` : ''}
          <div class="pdf-stay-meta">
            ${a.acCheckIn ? `<span><b>Check-in:</b> ${escapeHtml(a.acCheckIn)}</span>` : ''}
            ${a.acCheckOut ? `<span><b>Check-out:</b> ${escapeHtml(a.acCheckOut)}</span>` : ''}
            ${a.acNights ? `<span><b>Nights:</b> ${a.acNights}</span>` : ''}
            ${a.acConfirmation ? `<span><b>Booking:</b> ${escapeHtml(a.acConfirmation)}</span>` : ''}
            ${a.acContact ? `<span><b>Contact:</b> ${escapeHtml(a.acContact)}</span>` : ''}
            ${Number(a.cost) > 0 ? `<span><b>Cost:</b> ${fmtMoney(a.cost)}</span>` : ''}
          </div>
        </div>
      `).join('');
    }

    let actsHtml = '';
    if (others.length) {
      actsHtml = `<div class="pdf-section-label">Schedule</div>` + others.map(a => {
        const emoji = CATEGORY_EMOJI[a.category] || '📌';
        const parts = [];
        if (a.duration) parts.push(`${fmtDuration(a.duration)}`);
        if (Number(a.cost) > 0) parts.push(fmtMoney(a.cost));
        if (a.location) parts.push(`📍 ${escapeHtml(a.location)}`);

        let transport = '';
        if (a.category === 'transport') {
          const t = [];
          if (a.transportRef) t.push(`<b>Ref:</b> ${escapeHtml(a.transportRef)}`);
          if (a.transportCarrier) t.push(`<b>Carrier:</b> ${escapeHtml(a.transportCarrier)}`);
          if (a.transportFrom || a.transportTo) t.push(`<b>Route:</b> ${escapeHtml(a.transportFrom || '?')} → ${escapeHtml(a.transportTo || '?')}`);
          if (t.length) transport = `<div class="pdf-transport">${t.join(' &nbsp;·&nbsp; ')}</div>`;
        }

        return `
          <div class="pdf-activity">
            <div class="pdf-time">${escapeHtml(a.time || '')}</div>
            <div class="pdf-body">
              <div class="pdf-name">${emoji} ${escapeHtml(a.name)}</div>
              ${a.description ? `<div class="pdf-desc">${escapeHtml(a.description)}</div>` : ''}
              ${parts.length ? `<div class="pdf-meta">${parts.join(' · ')}</div>` : ''}
              ${transport}
            </div>
          </div>
        `;
      }).join('');
    }

    if (!stays.length && !others.length) {
      actsHtml = `<div class="pdf-empty">No activities scheduled</div>`;
    }

    return `
      <div class="pdf-day">
        <div class="pdf-day-header">
          <span class="pdf-day-num">Day ${dayNum}</span>
          <span class="pdf-day-date">${escapeHtml(dateLabel)}</span>
          <span class="pdf-day-cost">${fmtMoney(dayCost)}</span>
        </div>
        ${staysHtml}
        ${actsHtml}
      </div>
    `;
  }).join('');

  const budgetLine = trip.budget
    ? `<span><b>Budget:</b> ${fmtMoney(trip.budget)} (${Math.round((totalCost / trip.budget) * 100)}% used)</span>`
    : '';

  const html = `
    <div class="pdf-root">
      <div class="pdf-header">
        <h1>${escapeHtml(trip.name)}</h1>
        <div class="pdf-summary">
          <span><b>Dates:</b> ${escapeHtml(fmtDateRange(trip.startDate, trip.days))}</span>
          <span><b>Days:</b> ${trip.days}</span>
          <span><b>Activities:</b> ${acts.length}</span>
          <span><b>Total:</b> ${fmtMoney(totalCost)}</span>
          ${budgetLine}
        </div>
        ${trip.description ? `<div class="pdf-notes">${escapeHtml(trip.description)}</div>` : ''}
      </div>
      ${dayHtml}
      <div class="pdf-footer">Generated ${new Date().toLocaleDateString()} · Itinerary Planner</div>
    </div>
    <style>
      .pdf-root {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #111;
        background: #fff;
        padding: 24px 28px;
        line-height: 1.45;
        font-size: 11.5px;
      }
      .pdf-header { border-bottom: 2px solid #2b6dfb; padding-bottom: 14px; margin-bottom: 20px; }
      .pdf-header h1 { font-size: 22px; margin: 0 0 8px; color: #111; font-weight: 700; letter-spacing: -0.02em; }
      .pdf-summary { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 11px; color: #444; }
      .pdf-notes { margin-top: 8px; font-size: 11.5px; color: #555; font-style: italic; }
      .pdf-day { margin-bottom: 18px; page-break-inside: avoid; break-inside: avoid; }
      .pdf-day-header {
        background: #f2f5ff; border-left: 4px solid #2b6dfb; padding: 8px 12px;
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 10px; border-radius: 4px;
      }
      .pdf-day-num { font-weight: 700; color: #2b6dfb; font-size: 13px; }
      .pdf-day-date { color: #444; font-size: 12px; }
      .pdf-day-cost { color: #111; font-weight: 600; font-size: 12px; }
      .pdf-section-label {
        font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.08em;
        color: #888; font-weight: 700; margin: 12px 0 6px;
      }
      .pdf-stay {
        background: #f6f8fe; border: 1px solid #e2e8f7; border-radius: 5px;
        padding: 10px 12px; margin-bottom: 8px; page-break-inside: avoid; break-inside: avoid;
      }
      .pdf-stay-name { font-weight: 600; font-size: 12.5px; margin-bottom: 3px; }
      .pdf-stay-addr { color: #555; font-size: 11px; margin-bottom: 6px; }
      .pdf-stay-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 10.5px; color: #333; }
      .pdf-stay-meta b { color: #666; font-weight: 600; }
      .pdf-activity {
        display: grid; grid-template-columns: 60px 1fr; gap: 12px;
        padding: 8px 0; border-top: 1px solid #eee; page-break-inside: avoid; break-inside: avoid;
      }
      .pdf-activity:first-child { border-top: none; }
      .pdf-time {
        font-weight: 600; font-family: "SF Mono", Menlo, monospace;
        color: #111; font-size: 11.5px; padding-top: 1px;
      }
      .pdf-name { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
      .pdf-desc { color: #555; font-size: 11px; margin-bottom: 3px; }
      .pdf-meta { color: #666; font-size: 10.5px; }
      .pdf-transport {
        background: #fafbfc; border: 1px solid #eee; padding: 5px 8px;
        border-radius: 4px; margin-top: 4px; font-size: 10.5px; color: #333;
      }
      .pdf-transport b { color: #666; }
      .pdf-empty { color: #999; font-style: italic; padding: 8px 0; font-size: 11px; }
      .pdf-footer { text-align: center; color: #aaa; font-size: 10px; margin-top: 24px; padding-top: 10px; border-top: 1px solid #eee; }
    </style>
  `;

  const container = document.createElement('div');
  container.innerHTML = html;
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  container.style.width = '794px'; // A4 width at 96dpi
  document.body.appendChild(container);

  toast('Generating PDF…');

  try {
    await html2pdf().set({
      margin: [10, 8, 12, 8],
      filename: (trip.name || 'trip').replace(/[^a-z0-9-_]+/gi, '_') + '.pdf',
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    }).from(container.firstElementChild).save();
    toast('PDF downloaded', 'success');
  } catch (err) {
    console.error(err);
    toast('PDF export failed', 'error');
  } finally {
    document.body.removeChild(container);
  }
}

async function handleExportTrip() {
  if (!state.currentTripId) return;
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  const acts = await getActivitiesByTrip(trip.id);
  const payload = {
    name: trip.name, startDate: trip.startDate, days: trip.days,
    description: trip.description || '', budget: trip.budget || 0,
    locationName: trip.locationName || '', lat: trip.lat, lng: trip.lng,
    activities: acts.map(a => ({
      name: a.name, description: a.description, day: a.day, time: a.time,
      duration: a.duration, cost: a.cost, travelTime: a.travelTime,
      location: a.location, category: a.category,
      lat: a.lat, lng: a.lng,
      transportRef: a.transportRef, transportCarrier: a.transportCarrier,
      transportFrom: a.transportFrom, transportTo: a.transportTo,
      transportToLat: a.transportToLat, transportToLng: a.transportToLng,
      acCheckIn: a.acCheckIn, acCheckOut: a.acCheckOut, acNights: a.acNights,
      acConfirmation: a.acConfirmation, acAddress: a.acAddress, acContact: a.acContact,
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (trip.name || 'trip').replace(/[^a-z0-9-_]+/gi, '_') + '.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Trip exported', 'success');
}

async function handleDeleteTrip() {
  if (!state.currentTripId) return;
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  if (!confirm(`Delete "${trip.name}" and all its activities? This cannot be undone.`)) return;
  await deleteTripDB(state.currentTripId);
  toast('Trip deleted', 'success');
  state.currentTripId = null;
  await renderTripsList();
  switchView('trips');
}

/* =============================================================
 * ACTIVITY FORM
 * ============================================================= */
async function openActivityForm(activityId = null, defaultDay = null) {
  state.editingActivityId = activityId;
  state.pickedCoord = null;
  const form = document.getElementById('activity-form');
  form.reset();
  document.getElementById('coord-preview').classList.add('hidden');
  document.getElementById('location-results').classList.add('hidden');

  const trip = await getTrip(state.currentTripId);
  if (!trip) { switchView('trips'); return; }
  document.getElementById('af-day').max = trip.days;

  if (activityId) {
    const a = await getActivity(activityId);
    if (!a) { toast('Activity not found', 'error'); return; }
    document.getElementById('activity-form-title').textContent = 'Edit Activity';
    document.getElementById('af-name').value = a.name || '';
    document.getElementById('af-description').value = a.description || '';
    document.getElementById('af-day').value = a.day || 1;
    document.getElementById('af-time').value = a.time || '09:00';
    document.getElementById('af-duration').value = a.duration ?? 60;
    document.getElementById('af-cost').value = a.cost ?? 0;
    document.getElementById('af-travel').value = a.travelTime ?? 0;
    document.getElementById('af-location').value = a.location || '';
    document.getElementById('af-category').value = a.category || 'other';
    document.getElementById('af-lat').value = Number.isFinite(a.lat) ? a.lat : '';
    document.getElementById('af-lng').value = Number.isFinite(a.lng) ? a.lng : '';
    document.getElementById('af-tp-ref').value = a.transportRef || '';
    document.getElementById('af-tp-carrier').value = a.transportCarrier || '';
    document.getElementById('af-tp-from').value = a.transportFrom || '';
    document.getElementById('af-tp-to').value = a.transportTo || '';
    document.getElementById('af-ac-checkin').value = a.acCheckIn || '';
    document.getElementById('af-ac-checkout').value = a.acCheckOut || '';
    document.getElementById('af-ac-nights').value = a.acNights || '';
    document.getElementById('af-ac-confirmation').value = a.acConfirmation || '';
    document.getElementById('af-ac-address').value = a.acAddress || '';
    document.getElementById('af-ac-contact').value = a.acContact || '';
    if (Number.isFinite(a.lat) && Number.isFinite(a.lng)) {
      state.pickedCoord = { lat: a.lat, lng: a.lng, address: a.location || '' };
      showCoordPreview();
    }
    // Restore transport dest coords into pickers
    state.pickedTransportFromCoord = null;
    state.pickedTransportToCoord = null;
    if (Number.isFinite(a.transportToLat) && Number.isFinite(a.transportToLng)) {
      state.pickedTransportToCoord = { lat: a.transportToLat, lng: a.transportToLng };
    }
    updateCategoryFieldsVisibility();
  } else {
    document.getElementById('activity-form-title').textContent = 'Add Activity';
    document.getElementById('af-day').value = defaultDay || 1;
    document.getElementById('af-time').value = '09:00';
    document.getElementById('af-duration').value = 60;
    document.getElementById('af-cost').value = 0;
    document.getElementById('af-travel').value = 0;
    document.getElementById('af-category').value = 'sightseeing';
    document.getElementById('af-lat').value = '';
    document.getElementById('af-lng').value = '';
    document.getElementById('af-ac-checkin').value = '';
    document.getElementById('af-ac-checkout').value = '';
    document.getElementById('af-ac-nights').value = '';
    document.getElementById('af-ac-confirmation').value = '';
    document.getElementById('af-ac-address').value = '';
    document.getElementById('af-ac-contact').value = '';
    state.pickedTransportFromCoord = null;
    state.pickedTransportToCoord = null;
    updateCategoryFieldsVisibility();
  }

  switchView('activity-form');
  setTimeout(() => document.getElementById('af-name').focus(), 80);
}

function updateCategoryFieldsVisibility() {
  const cat = document.getElementById('af-category').value;
  document.getElementById('transport-fields').classList.toggle('show', cat === 'transport');
  document.getElementById('accommodation-fields').classList.toggle('show', cat === 'accommodation');
}

function showCoordPreview() {
  if (!state.pickedCoord) {
    document.getElementById('coord-preview').classList.add('hidden');
    return;
  }
  const el = document.getElementById('coord-preview');
  const t = document.getElementById('coord-preview-text');
  t.textContent = `◉ ${state.pickedCoord.lat.toFixed(5)}, ${state.pickedCoord.lng.toFixed(5)}`;
  el.classList.remove('hidden');
  // Reflect into manual fields
  document.getElementById('af-lat').value = state.pickedCoord.lat;
  document.getElementById('af-lng').value = state.pickedCoord.lng;
}

async function handleActivityFormSubmit(e) {
  e.preventDefault();
  const trip = await getTrip(state.currentTripId);
  if (!trip) { switchView('trips'); return; }

  const name = document.getElementById('af-name').value.trim();
  const day = parseInt(document.getElementById('af-day').value, 10);
  const time = document.getElementById('af-time').value;
  const duration = parseInt(document.getElementById('af-duration').value, 10);

  if (!name || !day || !time || isNaN(duration)) {
    toast('Please fill all required fields', 'error');
    return;
  }
  if (day < 1 || day > trip.days) {
    toast(`Day must be between 1 and ${trip.days}`, 'error');
    return;
  }

  const latManual = parseFloat(document.getElementById('af-lat').value);
  const lngManual = parseFloat(document.getElementById('af-lng').value);
  let lat = null, lng = null;
  if (state.pickedCoord) {
    lat = state.pickedCoord.lat; lng = state.pickedCoord.lng;
  } else if (Number.isFinite(latManual) && Number.isFinite(lngManual)) {
    lat = latManual; lng = lngManual;
  } else {
    // Best-effort geocode from location text
    const loc = document.getElementById('af-location').value.trim();
    if (loc) {
      try {
        const res = await window.MapMod.geocode(loc, 1);
        if (res.length) { lat = res[0].lat; lng = res[0].lng; }
      } catch (e) {}
    }
  }

  const category = document.getElementById('af-category').value;

  // Transport destination coords (best-effort geocode if not picked)
  let toLat = null, toLng = null;
  if (category === 'transport') {
    if (state.pickedTransportToCoord) {
      toLat = state.pickedTransportToCoord.lat;
      toLng = state.pickedTransportToCoord.lng;
    } else {
      const toText = document.getElementById('af-tp-to').value.trim();
      if (toText) {
        try {
          const res = await window.MapMod.geocode(toText, 1);
          if (res.length) { toLat = res[0].lat; toLng = res[0].lng; }
        } catch (e) {}
      }
    }
    // If no origin coord set yet, try to geocode transportFrom
    if (!(Number.isFinite(lat) && Number.isFinite(lng))) {
      const fromText = document.getElementById('af-tp-from').value.trim();
      if (fromText) {
        try {
          const r = state.pickedTransportFromCoord
            ? [state.pickedTransportFromCoord]
            : await window.MapMod.geocode(fromText, 1);
          if (r.length) { lat = r[0].lat; lng = r[0].lng; }
        } catch (e) {}
      }
    }
  }

  const payload = {
    tripId: trip.id,
    name,
    description: document.getElementById('af-description').value.trim(),
    day, time, duration,
    cost: parseFloat(document.getElementById('af-cost').value) || 0,
    travelTime: parseInt(document.getElementById('af-travel').value, 10) || 0,
    location: document.getElementById('af-location').value.trim(),
    category,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    transportRef: document.getElementById('af-tp-ref').value.trim(),
    transportCarrier: document.getElementById('af-tp-carrier').value.trim(),
    transportFrom: document.getElementById('af-tp-from').value.trim(),
    transportTo: document.getElementById('af-tp-to').value.trim(),
    transportToLat: Number.isFinite(toLat) ? toLat : null,
    transportToLng: Number.isFinite(toLng) ? toLng : null,
    acCheckIn: document.getElementById('af-ac-checkin').value.trim(),
    acCheckOut: document.getElementById('af-ac-checkout').value.trim(),
    acNights: parseInt(document.getElementById('af-ac-nights').value, 10) || null,
    acConfirmation: document.getElementById('af-ac-confirmation').value.trim(),
    acAddress: document.getElementById('af-ac-address').value.trim(),
    acContact: document.getElementById('af-ac-contact').value.trim(),
  };

  if (state.editingActivityId) {
    const existing = await getActivity(state.editingActivityId);
    await saveActivity({ ...existing, ...payload });
    toast('Activity updated', 'success');
  } else {
    await saveActivity({
      id: newId(),
      ...payload,
      completed: false,
      createdAt: Date.now(),
    });
    toast('Activity added', 'success');
  }

  state.editingActivityId = null;
  state.pickedCoord = null;
  await renderTripDetail();
  renderWeather();
  switchView('trip-detail');
}

async function handleDeleteActivity(id) {
  if (!confirm('Delete this activity?')) return;
  await deleteActivityDB(id);
  toast('Activity deleted', 'success');
  await renderTripDetail();
}
async function handleToggleComplete(id) {
  const a = await getActivity(id);
  if (!a) return;
  a.completed = !a.completed;
  await saveActivity(a);
  await renderTripDetail();
}

/* =============================================================
 * FILE IMPORT
 * ============================================================= */
function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        cur.push(field);
        if (cur.some(v => v !== '')) rows.push(cur);
        cur = []; field = '';
      } else { field += c; }
    }
  }
  if (field.length || cur.length) {
    cur.push(field);
    if (cur.some(v => v !== '')) rows.push(cur);
  }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, idx) => o[h] = (r[idx] ?? '').trim());
    return o;
  });
}

function normalizeActivityRecord(raw, tripId) {
  const cat = String(raw.category || 'other').toLowerCase();
  return {
    id: newId(), tripId,
    name: String(raw.name || '').trim(),
    description: String(raw.description || '').trim(),
    day: parseInt(raw.day, 10) || 1,
    time: String(raw.time || '09:00').trim(),
    duration: parseInt(raw.duration, 10) || 0,
    cost: parseFloat(raw.cost) || 0,
    travelTime: parseInt(raw.travelTime ?? raw.traveltime, 10) || 0,
    location: String(raw.location || '').trim(),
    category: CATEGORY_LABEL[cat] ? cat : 'other',
    lat: parseFloat(raw.lat),
    lng: parseFloat(raw.lng ?? raw.lon ?? raw.longitude),
    transportRef: String(raw.transportRef ?? raw.transportref ?? raw.ref ?? '').trim(),
    transportCarrier: String(raw.transportCarrier ?? raw.transportcarrier ?? raw.carrier ?? '').trim(),
    transportFrom: String(raw.transportFrom ?? raw.transportfrom ?? raw.from ?? '').trim(),
    transportTo: String(raw.transportTo ?? raw.transportto ?? raw.to ?? '').trim(),
    transportToLat: parseFloat(raw.transportToLat ?? raw.transporttolat ?? raw.tolat),
    transportToLng: parseFloat(raw.transportToLng ?? raw.transporttolng ?? raw.tolng ?? raw.tolon),
    acCheckIn: String(raw.acCheckIn ?? raw.accheckin ?? raw.checkin ?? '').trim(),
    acCheckOut: String(raw.acCheckOut ?? raw.accheckout ?? raw.checkout ?? '').trim(),
    acNights: parseInt(raw.acNights ?? raw.acnights ?? raw.nights, 10) || null,
    acConfirmation: String(raw.acConfirmation ?? raw.acconfirmation ?? raw.confirmation ?? '').trim(),
    acAddress: String(raw.acAddress ?? raw.acaddress ?? raw.address ?? '').trim(),
    acContact: String(raw.acContact ?? raw.accontact ?? raw.contact ?? '').trim(),
    completed: false, createdAt: Date.now(),
  };
}

async function handleImportActivities(file) {
  if (!file || !state.currentTripId) return;
  try {
    const text = await file.text();
    let records = [];
    if (file.name.toLowerCase().endsWith('.json')) {
      const data = JSON.parse(text);
      records = Array.isArray(data) ? data : (data.activities || []);
    } else {
      records = parseCSV(text);
    }
    if (!records.length) { toast('No records found', 'error'); return; }

    let count = 0;
    for (const raw of records) {
      const rec = normalizeActivityRecord(raw, state.currentTripId);
      if (!rec.name) continue;
      await new Promise(r => setTimeout(r, 1));
      rec.id = newId();
      // Clean NaN coords
      if (!Number.isFinite(rec.lat)) rec.lat = null;
      if (!Number.isFinite(rec.lng)) rec.lng = null;
      if (!Number.isFinite(rec.transportToLat)) rec.transportToLat = null;
      if (!Number.isFinite(rec.transportToLng)) rec.transportToLng = null;
      await saveActivity(rec);
      count++;
    }
    toast(`Imported ${count} activit${count === 1 ? 'y' : 'ies'}`, 'success');
    await renderTripDetail();
  } catch (err) {
    console.error(err);
    toast('Import failed: ' + err.message, 'error');
  }
}

async function handleImportTrips(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const trips = Array.isArray(data) ? data : (data.trips ? data.trips : [data]);
    let count = 0;
    for (const raw of trips) {
      if (!raw || !raw.name) continue;
      const trip = {
        id: newId(),
        name: String(raw.name),
        startDate: String(raw.startDate || new Date().toISOString().slice(0, 10)),
        days: parseInt(raw.days, 10) || 1,
        description: String(raw.description || ''),
        budget: parseFloat(raw.budget) || 0,
        locationName: String(raw.locationName || ''),
        lat: Number.isFinite(parseFloat(raw.lat)) ? parseFloat(raw.lat) : null,
        lng: Number.isFinite(parseFloat(raw.lng)) ? parseFloat(raw.lng) : null,
        createdAt: Date.now(),
        ownerUid: state.user ? state.user.uid : null,
      };
      await new Promise(r => setTimeout(r, 1));
      trip.id = newId();
      await saveTrip(trip);
      if (Array.isArray(raw.activities)) {
        for (const a of raw.activities) {
          await new Promise(r => setTimeout(r, 1));
          const rec = normalizeActivityRecord(a, trip.id);
          rec.id = newId();
          if (!Number.isFinite(rec.lat)) rec.lat = null;
          if (!Number.isFinite(rec.lng)) rec.lng = null;
          if (!Number.isFinite(rec.transportToLat)) rec.transportToLat = null;
          if (!Number.isFinite(rec.transportToLng)) rec.transportToLng = null;
          if (rec.name) await saveActivity(rec);
        }
      }
      count++;
    }
    toast(`Imported ${count} trip${count === 1 ? '' : 's'}`, 'success');
    await renderTripsList();
  } catch (err) {
    console.error(err);
    toast('Import failed: ' + err.message, 'error');
  }
}

/* =============================================================
 * INSTALL PROMPT
 * ============================================================= */
let deferredInstallPrompt = null;
function setupInstallPrompt() {
  const banner = document.getElementById('install-banner');
  const btn = document.getElementById('install-btn');
  const dismiss = document.getElementById('install-dismiss');
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  if (window.navigator.standalone === true) return;
  if (localStorage.getItem('install-dismissed') === '1') return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    banner.classList.remove('hidden');
  });
  btn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) { banner.classList.add('hidden'); return; }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    banner.classList.add('hidden');
  });
  dismiss.addEventListener('click', () => {
    banner.classList.add('hidden');
    localStorage.setItem('install-dismissed', '1');
  });
  window.addEventListener('appinstalled', () => {
    banner.classList.add('hidden');
    toast('App installed', 'success');
  });
}

/* =============================================================
 * SERVICE WORKER
 * ============================================================= */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  });
}

/* =============================================================
 * EVENT WIRING
 * ============================================================= */
function wireEvents() {
  // Back
  document.getElementById('back-btn').addEventListener('click', () => {
    if (state.currentView === 'activity-form') {
      state.editingActivityId = null;
      switchView('trip-detail');
    } else if (state.currentView === 'trip-detail') {
      state.currentTripId = null;
      window.MapMod.destroyAllMaps();
      switchView('trips');
    }
  });

  // Theme
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  updateThemeIcon();

  // Auth
  document.getElementById('auth-chip').addEventListener('click', () => {
    if (!state.firebaseReady) return;
    if (state.user) signOut(); else signIn();
  });
  document.getElementById('signin-prompt-btn').addEventListener('click', signIn);

  // Trips list
  document.getElementById('new-trip-btn').addEventListener('click', () => openTripModal(null));
  document.getElementById('import-trips-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) handleImportTrips(f);
  });

  // Trip modal
  document.getElementById('trip-form').addEventListener('submit', handleTripFormSubmit);
  document.getElementById('tf-cancel').addEventListener('click', closeTripModal);
  document.getElementById('trip-modal').addEventListener('click', (e) => {
    if (e.target.id === 'trip-modal') closeTripModal();
  });

  // Trip location geocode
  window.MapMod.attachGeocodeSearch(
    document.getElementById('tf-location'),
    document.getElementById('trip-location-results'),
    (pick) => {
      state.pickedTripCoord = { lat: pick.lat, lng: pick.lng, address: pick.address };
      document.getElementById('tf-location').value = pick.name;
    }
  );

  // Trip detail
  document.getElementById('add-activity-btn').addEventListener('click', () => openActivityForm(null));
  document.getElementById('edit-trip-btn').addEventListener('click', () => openTripModal(state.currentTripId));
  document.getElementById('export-trip-btn').addEventListener('click', handleExportTrip);
  document.getElementById('export-pdf-btn').addEventListener('click', handleExportPDF);
  document.getElementById('delete-trip-btn').addEventListener('click', handleDeleteTrip);
  document.getElementById('import-activities-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) handleImportActivities(f);
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // Activity form
  document.getElementById('activity-form').addEventListener('submit', handleActivityFormSubmit);
  document.getElementById('af-cancel').addEventListener('click', () => {
    state.editingActivityId = null;
    switchView('trip-detail');
  });
  document.getElementById('af-category').addEventListener('change', updateCategoryFieldsVisibility);

  // Location search on activity
  window.MapMod.attachGeocodeSearch(
    document.getElementById('af-location'),
    document.getElementById('location-results'),
    (pick) => {
      state.pickedCoord = { lat: pick.lat, lng: pick.lng, address: pick.address };
      document.getElementById('af-location').value = pick.name;
      showCoordPreview();
    }
  );
  // Transport From/To geocode search
  window.MapMod.attachGeocodeSearch(
    document.getElementById('af-tp-from'),
    document.getElementById('tp-from-results'),
    (pick) => {
      state.pickedTransportFromCoord = { lat: pick.lat, lng: pick.lng };
      document.getElementById('af-tp-from').value = pick.name;
      // If main location isn't set yet, seed it from the origin
      if (!state.pickedCoord) {
        state.pickedCoord = { lat: pick.lat, lng: pick.lng, address: pick.address };
        showCoordPreview();
      }
    }
  );
  window.MapMod.attachGeocodeSearch(
    document.getElementById('af-tp-to'),
    document.getElementById('tp-to-results'),
    (pick) => {
      state.pickedTransportToCoord = { lat: pick.lat, lng: pick.lng };
      document.getElementById('af-tp-to').value = pick.name;
      toast('Destination pinned on map', 'success');
    }
  );

  // Clear coord
  document.getElementById('clear-coord').addEventListener('click', () => {
    state.pickedCoord = null;
    document.getElementById('af-lat').value = '';
    document.getElementById('af-lng').value = '';
    document.getElementById('coord-preview').classList.add('hidden');
  });
  // Manual lat/lng edits
  ['af-lat', 'af-lng'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      const lat = parseFloat(document.getElementById('af-lat').value);
      const lng = parseFloat(document.getElementById('af-lng').value);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        state.pickedCoord = { lat, lng, address: '' };
        showCoordPreview();
      }
    });
  });

  // Escape closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('trip-modal').classList.contains('hidden')) {
      closeTripModal();
    }
  });
}

/* =============================================================
 * BOOTSTRAP
 * ============================================================= */
async function init() {
  try {
    state.db = await openDB();
  } catch (err) {
    console.error('DB open failed:', err);
    toast('Could not open local database', 'error');
    return;
  }
  wireEvents();
  await renderTripsList();
  await initFirebase();
  updateAuthUI();
  registerSW();
  setupInstallPrompt();
}

document.addEventListener('DOMContentLoaded', init);
