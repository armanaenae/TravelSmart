/* =============================================================
 * Itinerary Planner - Offline PWA + Firebase sync
 * ============================================================= */

'use strict';

/* =============================================================
 * CONSTANTS
 * ============================================================= */
const DB_NAME = 'itinerary-planner';
const DB_VERSION = 3;
const STORE_TRIPS = 'trips';
const STORE_ACTIVITIES = 'activities';
const STORE_STAYS = 'stays';
const STORE_IDEAS = 'ideas';
const STORE_ATTACHMENTS = 'attachments';
const STORE_META = 'meta';

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5 MB

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
  currentView: 'login',
  currentTab: 'schedule',
  user: null,
  authKnown: false,           // set once we've heard from Firebase
  offlineMode: false,          // user explicitly chose "continue offline"
  firebaseReady: false,
  firestore: null,
  auth: null,
  unsubTrips: null,
  unsubActs: null,
  syncingInitial: false,       // true while first sync payload is loading
  gotOwnedSnap: false,
  gotCollabSnap: false,
  pickedCoord: null, // { lat, lng, address }
  pickedTripCoord: null,
  pickedTransportFromCoord: null,
  pickedTransportToCoord: null,
  pickedStayCoord: null,
  pickedIdeaCoord: null,
  editingStayId: null,
  editingIdeaId: null,
  schedulingIdeaId: null,
  pendingAttachments: [], // buffered until save
  unsubStays: null,
  unsubIdeas: null,
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
      if (!db.objectStoreNames.contains(STORE_STAYS)) {
        const s = db.createObjectStore(STORE_STAYS, { keyPath: 'id' });
        s.createIndex('tripId', 'tripId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_IDEAS)) {
        const s = db.createObjectStore(STORE_IDEAS, { keyPath: 'id' });
        s.createIndex('tripId', 'tripId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) {
        // Attachments are stored as blobs locally; keyed by id.
        // parent = { kind: 'activity'|'stay', id: number }, tripId included for scoping
        const s = db.createObjectStore(STORE_ATTACHMENTS, { keyPath: 'id' });
        s.createIndex('tripId', 'tripId', { unique: false });
        s.createIndex('parentKey', 'parentKey', { unique: false });
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
async function saveTrip(trip, opts = {}) {
  trip.updatedAt = Date.now();
  await reqP(tx(STORE_TRIPS, 'readwrite').put(trip));
  if (state.user && !trip._fromCloud) {
    // opts.awaitCloud: wait for the Firestore write to be acknowledged
    // (important for invite flows before sign-out).
    if (opts.awaitCloud) {
      await syncTripUp(trip);
    } else {
      syncTripUp(trip);
    }
  }
  return trip;
}
async function deleteTripDB(id) {
  await reqP(tx(STORE_TRIPS, 'readwrite').delete(id));
  const acts = await getActivitiesByTrip(id);
  const actStore = tx(STORE_ACTIVITIES, 'readwrite');
  await Promise.all(acts.map(a => reqP(actStore.delete(a.id))));
  const stays = await getStaysByTrip(id);
  const stayStore = tx(STORE_STAYS, 'readwrite');
  await Promise.all(stays.map(s => reqP(stayStore.delete(s.id))));
  const ideas = await getIdeasByTrip(id);
  const ideaStore = tx(STORE_IDEAS, 'readwrite');
  await Promise.all(ideas.map(i => reqP(ideaStore.delete(i.id))));
  // Attachments scoped by tripId
  const attStore = tx(STORE_ATTACHMENTS);
  const atts = await new Promise((res, rej) => {
    const r = attStore.index('tripId').getAll(id);
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
  const attRW = tx(STORE_ATTACHMENTS, 'readwrite');
  await Promise.all(atts.map(a => reqP(attRW.delete(a.id))));
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
  // Cascade: remove attachments
  await deleteAttachmentsForParent(a && a.tripId, 'activity', id);
  if (state.user && a) deleteActivityCloud(a.tripId, id);
}

/* --- Stays --- */
async function getStaysByTrip(tripId) {
  return new Promise((resolve, reject) => {
    const store = tx(STORE_STAYS);
    const req = store.index('tripId').getAll(tripId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function getStay(id) { return reqP(tx(STORE_STAYS).get(id)); }
async function saveStay(s) {
  s.updatedAt = Date.now();
  await reqP(tx(STORE_STAYS, 'readwrite').put(s));
  if (state.user && !s._fromCloud) syncStayUp(s);
  return s;
}
async function deleteStayDB(id) {
  const s = await getStay(id);
  await reqP(tx(STORE_STAYS, 'readwrite').delete(id));
  await deleteAttachmentsForParent(s && s.tripId, 'stay', id);
  if (state.user && s) deleteStayCloud(s.tripId, id);
}

/* --- Ideas --- */
async function getIdeasByTrip(tripId) {
  return new Promise((resolve, reject) => {
    const store = tx(STORE_IDEAS);
    const req = store.index('tripId').getAll(tripId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function getIdea(id) { return reqP(tx(STORE_IDEAS).get(id)); }
async function saveIdea(i) {
  i.updatedAt = Date.now();
  await reqP(tx(STORE_IDEAS, 'readwrite').put(i));
  if (state.user && !i._fromCloud) syncIdeaUp(i);
  return i;
}
async function deleteIdeaDB(id) {
  const i = await getIdea(id);
  await reqP(tx(STORE_IDEAS, 'readwrite').delete(id));
  if (state.user && i) deleteIdeaCloud(i.tripId, id);
}

/* --- Attachments --- */
function parentKey(kind, id) { return kind + ':' + id; }

async function getAttachmentsForParent(kind, parentId) {
  return new Promise((resolve, reject) => {
    const store = tx(STORE_ATTACHMENTS);
    const req = store.index('parentKey').getAll(parentKey(kind, parentId));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function getAttachment(id) { return reqP(tx(STORE_ATTACHMENTS).get(id)); }
async function saveAttachment(att) {
  att.updatedAt = Date.now();
  await reqP(tx(STORE_ATTACHMENTS, 'readwrite').put(att));
  // Attachments are LOCAL-ONLY (Firestore has 1MB doc limit and Storage requires
  // billing on some tiers). They stay on the device that added them.
  return att;
}
async function deleteAttachment(id) {
  return reqP(tx(STORE_ATTACHMENTS, 'readwrite').delete(id));
}
async function deleteAttachmentsForParent(tripId, kind, parentId) {
  const list = await getAttachmentsForParent(kind, parentId);
  const store = tx(STORE_ATTACHMENTS, 'readwrite');
  await Promise.all(list.map(a => reqP(store.delete(a.id))));
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
    // Show the login "no-config" warning and let the user proceed offline
    document.getElementById('login-config-warn').classList.remove('hidden');
    document.getElementById('login-google-btn').classList.add('hidden');
    document.getElementById('config-banner').classList.remove('hidden');
    state.authKnown = true;
    return;
  }
  document.getElementById('login-config-warn').classList.add('hidden');
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

    // Handle redirect result (in case popup was blocked)
    try { await state.auth.getRedirectResult(); } catch (e) { /* ignore */ }

    state.auth.onAuthStateChanged(handleAuthChange);
  } catch (err) {
    console.error('Firebase init failed:', err);
    document.getElementById('login-config-warn').classList.remove('hidden');
    state.authKnown = true;
  }
}

async function handleAuthChange(user) {
  state.user = user || null;
  state.authKnown = true;
  updateAuthUI();

  if (user) {
    // We're signed in — go to trips view (from login gate or wherever)
    state.offlineMode = false;
    state.syncingInitial = true;
    state.gotOwnedSnap = false;
    state.gotCollabSnap = false;

    // Show trips view immediately with syncing placeholder if empty
    if (state.currentView === 'login') switchView('trips');

    // Start cloud sync BEFORE migration so listeners are live
    startCloudSync();
    // Push local trips that don't have ownerUid (first-run only)
    await migrateLocalToCloud();
    renderTripsList();
  } else {
    // Signed out — clear local + cloud subs + gate
    stopCloudSync();
    await clearLocalDataForSignOut();
    if (!state.offlineMode) {
      switchView('login');
    }
    renderTripsList();
  }
}

/**
 * Nuke local IDB stores so previous user's trips don't leak visually
 * to the sign-in screen or to the next user on this device.
 */
async function clearLocalDataForSignOut() {
  try {
    const stores = [STORE_TRIPS, STORE_ACTIVITIES, STORE_STAYS, STORE_IDEAS];
    for (const s of stores) {
      await reqP(tx(s, 'readwrite').clear());
    }
    // Note: we keep attachments (they're local-only anyway).
    // Keep META too (theme etc).
  } catch (e) { console.warn('Local clear failed:', e); }
}

function updateAuthUI() {
  const chip = document.getElementById('auth-chip');
  const dot = document.getElementById('sync-dot');
  const avatar = document.getElementById('auth-avatar');
  const label = document.getElementById('auth-label');
  const prompt = document.getElementById('signin-prompt');

  // Never show chip on login screen
  if (state.currentView === 'login') {
    chip.classList.add('hidden');
  } else if (!isFirebaseConfigured()) {
    chip.classList.add('hidden');
    prompt.classList.add('hidden');
  } else {
    chip.classList.remove('hidden');
  }

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
    label.textContent = state.user.email
      ? state.user.email.split('@')[0]
      : 'Signed in';
  } else {
    // Offline mode → show the "not signed in" banner on trips page
    if (state.offlineMode && isFirebaseConfigured()) {
      prompt.classList.remove('hidden');
    } else {
      prompt.classList.add('hidden');
    }
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
  try {
    await state.auth.signOut();
    // handleAuthChange will clear local data and gate to login
    toast('Signed out', 'success');
  } catch (err) {
    console.error(err);
    toast('Sign-out failed', 'error');
  }
}

/* =============================================================
 * CLOUD SYNC (Firestore)
 * Doc layout (root-level so collaborators can access):
 *   trips/{tripId}                            — has ownerUid + collaborators[] (lowercased emails)
 *   trips/{tripId}/activities/{activityId}
 *   trips/{tripId}/stays/{stayId}
 *   trips/{tripId}/ideas/{ideaId}
 * ============================================================= */
function tripsCol() { return state.firestore.collection('trips'); }
function tripDoc(tripId) { return tripsCol().doc(String(tripId)); }
function actsCol(tripId) { return tripDoc(tripId).collection('activities'); }
function staysCol(tripId) { return tripDoc(tripId).collection('stays'); }
function ideasCol(tripId) { return tripDoc(tripId).collection('ideas'); }

function startCloudSync() {
  if (!state.user) return;
  stopCloudSync();

  const email = (state.user.email || '').toLowerCase();

  // Two queries: trips I own, and trips I collaborate on.
  const ownedQ = tripsCol().where('ownerUid', '==', state.user.uid);
  const collabQ = email ? tripsCol().where('collaborators', 'array-contains', email) : null;

  const applySnap = async (snap) => {
    for (const ch of snap.docChanges()) {
      const data = ch.doc.data();
      data.id = Number(ch.doc.id);
      if (ch.type === 'removed') {
        const local = await getTrip(data.id);
        if (local) await reqP(tx(STORE_TRIPS, 'readwrite').delete(data.id));
      } else {
        const local = await getTrip(data.id);
        if (!local || (data.updatedAt || 0) >= (local.updatedAt || 0)) {
          data._fromCloud = true;
          await reqP(tx(STORE_TRIPS, 'readwrite').put(data));
          delete data._fromCloud;
        }
      }
    }
    // Subscribe to child collections whenever the trip set changes
    subscribeToAllTripChildren();
    renderTripsList();
    if (state.currentTripId) renderTripDetail();
  };

  const maybeClearSyncing = () => {
    if (state.gotOwnedSnap && (state.gotCollabSnap || !collabQ)) {
      state.syncingInitial = false;
      renderTripsList();
    }
  };

  const unsubOwned = ownedQ.onSnapshot(async snap => {
    await applySnap(snap);
    state.gotOwnedSnap = true;
    maybeClearSyncing();
  }, err => {
    console.warn('Owned trips sync error:', err);
    state.gotOwnedSnap = true;
    maybeClearSyncing();
    if (err && err.code === 'permission-denied') {
      toast('Cloud rules block reads. Update Firestore rules per README.', 'error');
    }
  });

  let unsubCollab = () => {};
  if (collabQ) {
    unsubCollab = collabQ.onSnapshot(async snap => {
      await applySnap(snap);
      state.gotCollabSnap = true;
      maybeClearSyncing();
    }, err => {
      console.warn('Collab trips sync error:', err);
      state.gotCollabSnap = true;
      maybeClearSyncing();
    });
  } else {
    state.gotCollabSnap = true;
  }

  state.unsubTrips = () => { unsubOwned(); unsubCollab(); };
}

function stopCloudSync() {
  if (state.unsubTrips) { state.unsubTrips(); state.unsubTrips = null; }
  const unsubAll = (map) => {
    if (!map) return;
    Object.values(map).forEach(fn => fn && fn());
  };
  unsubAll(state.unsubActs); state.unsubActs = null;
  unsubAll(state.unsubStays); state.unsubStays = null;
  unsubAll(state.unsubIdeas); state.unsubIdeas = null;
}

async function subscribeToAllTripChildren() {
  if (!state.user) return;
  if (!state.unsubActs) state.unsubActs = {};
  if (!state.unsubStays) state.unsubStays = {};
  if (!state.unsubIdeas) state.unsubIdeas = {};

  const trips = await getAllTrips();
  const wanted = new Set(trips.map(t => String(t.id)));

  // Unsubscribe stale
  ['unsubActs', 'unsubStays', 'unsubIdeas'].forEach(k => {
    Object.keys(state[k]).forEach(id => {
      if (!wanted.has(id)) { state[k][id](); delete state[k][id]; }
    });
  });

  for (const t of trips) {
    const key = String(t.id);
    // Activities
    if (!state.unsubActs[key]) {
      state.unsubActs[key] = actsCol(t.id).onSnapshot(async snap => {
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
      }, err => console.warn('Activity sync err:', err));
    }
    // Stays
    if (!state.unsubStays[key]) {
      state.unsubStays[key] = staysCol(t.id).onSnapshot(async snap => {
        for (const ch of snap.docChanges()) {
          const data = ch.doc.data();
          data.id = Number(ch.doc.id);
          data.tripId = t.id;
          if (ch.type === 'removed') {
            await reqP(tx(STORE_STAYS, 'readwrite').delete(data.id));
          } else {
            const local = await getStay(data.id);
            if (!local || (data.updatedAt || 0) >= (local.updatedAt || 0)) {
              data._fromCloud = true;
              await reqP(tx(STORE_STAYS, 'readwrite').put(data));
              delete data._fromCloud;
            }
          }
        }
        if (state.currentTripId === t.id) renderTripDetail();
      }, err => console.warn('Stay sync err:', err));
    }
    // Ideas
    if (!state.unsubIdeas[key]) {
      state.unsubIdeas[key] = ideasCol(t.id).onSnapshot(async snap => {
        for (const ch of snap.docChanges()) {
          const data = ch.doc.data();
          data.id = Number(ch.doc.id);
          data.tripId = t.id;
          if (ch.type === 'removed') {
            await reqP(tx(STORE_IDEAS, 'readwrite').delete(data.id));
          } else {
            const local = await getIdea(data.id);
            if (!local || (data.updatedAt || 0) >= (local.updatedAt || 0)) {
              data._fromCloud = true;
              await reqP(tx(STORE_IDEAS, 'readwrite').put(data));
              delete data._fromCloud;
            }
          }
        }
        if (state.currentTripId === t.id && state.currentTab === 'ideas') renderIdeasTab();
      }, err => console.warn('Idea sync err:', err));
    }
  }
}

async function syncTripUp(trip) {
  if (!state.user) return;
  try {
    const clean = { ...trip };
    delete clean._fromCloud;
    if (!clean.ownerUid) clean.ownerUid = state.user.uid;
    if (!Array.isArray(clean.collaborators)) clean.collaborators = [];
    await tripDoc(trip.id).set(clean, { merge: true });
    // With offline persistence enabled, set() resolves once the write is queued
    // locally, NOT once the server has acked. If we sign out immediately after
    // (e.g. after inviting), that queued write is dropped. Force a server
    // round-trip so critical writes (like invite) actually land.
    try { await state.firestore.waitForPendingWrites(); } catch (e) {}
  } catch (err) { console.warn('Trip upload failed:', err); throw err; }
}
async function deleteTripCloud(id) {
  if (!state.user) return;
  try {
    // Delete children first
    const [acts, stays, ideas] = await Promise.all([
      actsCol(id).get(), staysCol(id).get(), ideasCol(id).get(),
    ]);
    const batch = state.firestore.batch();
    acts.forEach(d => batch.delete(d.ref));
    stays.forEach(d => batch.delete(d.ref));
    ideas.forEach(d => batch.delete(d.ref));
    batch.delete(tripDoc(id));
    await batch.commit();
  } catch (err) { console.warn('Trip cloud delete failed:', err); }
}
async function syncActivityUp(a) {
  if (!state.user) return;
  try {
    const clean = { ...a };
    delete clean._fromCloud;
    await actsCol(a.tripId).doc(String(a.id)).set(clean, { merge: true });
  } catch (err) { console.warn('Activity upload failed:', err); }
}
async function deleteActivityCloud(tripId, actId) {
  if (!state.user) return;
  try { await actsCol(tripId).doc(String(actId)).delete(); }
  catch (err) { console.warn('Activity cloud delete failed:', err); }
}
async function syncStayUp(s) {
  if (!state.user) return;
  try {
    const clean = { ...s }; delete clean._fromCloud;
    await staysCol(s.tripId).doc(String(s.id)).set(clean, { merge: true });
  } catch (err) { console.warn('Stay upload failed:', err); }
}
async function deleteStayCloud(tripId, stayId) {
  if (!state.user) return;
  try { await staysCol(tripId).doc(String(stayId)).delete(); }
  catch (err) { console.warn('Stay cloud delete failed:', err); }
}
async function syncIdeaUp(i) {
  if (!state.user) return;
  try {
    const clean = { ...i }; delete clean._fromCloud;
    await ideasCol(i.tripId).doc(String(i.id)).set(clean, { merge: true });
  } catch (err) { console.warn('Idea upload failed:', err); }
}
async function deleteIdeaCloud(tripId, ideaId) {
  if (!state.user) return;
  try { await ideasCol(tripId).doc(String(ideaId)).delete(); }
  catch (err) { console.warn('Idea cloud delete failed:', err); }
}

async function migrateLocalToCloud() {
  if (!state.user) return;
  const trips = await getAllTrips();
  for (const t of trips) {
    if (!t.ownerUid) {
      t.ownerUid = state.user.uid;
      if (!Array.isArray(t.collaborators)) t.collaborators = [];
      await reqP(tx(STORE_TRIPS, 'readwrite').put(t));
      await syncTripUp(t);
      const [acts, stays, ideas] = await Promise.all([
        getActivitiesByTrip(t.id), getStaysByTrip(t.id), getIdeasByTrip(t.id),
      ]);
      for (const a of acts) await syncActivityUp(a);
      for (const s of stays) await syncStayUp(s);
      for (const i of ideas) await syncIdeaUp(i);
    }
  }
  // Also migrate legacy users/{uid}/trips → root trips (best-effort, one-time)
  await migrateLegacyPath();
}

async function migrateLegacyPath() {
  try {
    const legacyCol = state.firestore.collection('users').doc(state.user.uid).collection('trips');
    const snap = await legacyCol.get();
    if (snap.empty) return;
    for (const doc of snap.docs) {
      const data = doc.data();
      data.id = Number(doc.id);
      data.ownerUid = state.user.uid;
      if (!Array.isArray(data.collaborators)) data.collaborators = [];
      data.updatedAt = Date.now();
      // Only migrate if root doc doesn't already exist
      const rootExists = await tripDoc(data.id).get();
      if (rootExists.exists) continue;
      await tripDoc(data.id).set(data, { merge: true });
      // Migrate legacy activities
      const legacyActs = await legacyCol.doc(doc.id).collection('activities').get();
      for (const ad of legacyActs.docs) {
        const av = ad.data(); av.id = Number(ad.id); av.tripId = data.id;
        await actsCol(data.id).doc(ad.id).set(av, { merge: true });
      }
    }
    if (!snap.empty) toast('Migrated cloud data to new collaborative format', 'success');
  } catch (err) {
    console.warn('Legacy migration skipped:', err);
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
  const el = document.getElementById('view-' + view);
  if (el) el.classList.add('active');

  const backBtn = document.getElementById('back-btn');
  const title = document.getElementById('header-title');
  const header = document.querySelector('.app-header');
  const themeBtn = document.getElementById('theme-toggle');
  const authChip = document.getElementById('auth-chip');

  // Login: hide most chrome
  if (view === 'login') {
    backBtn.classList.add('hidden');
    title.textContent = 'Itinerary';
    if (authChip) authChip.classList.add('hidden');
    if (themeBtn) themeBtn.classList.remove('hidden');
    // Ensure no other view is showing trip data
    updateAuthUI();
  } else if (view === 'trips') {
    backBtn.classList.add('hidden');
    title.textContent = 'Itinerary';
    if (authChip && (state.firebaseReady || state.user)) authChip.classList.remove('hidden');
  } else if (view === 'trip-detail') {
    backBtn.classList.remove('hidden');
    title.textContent = 'Trip';
    if (authChip && (state.firebaseReady || state.user)) authChip.classList.remove('hidden');
  } else if (view === 'activity-form' || view === 'stay-form' || view === 'idea-form') {
    backBtn.classList.remove('hidden');
    title.textContent = view === 'activity-form'
      ? (state.editingActivityId ? 'Edit Activity' : 'New Activity')
      : view === 'stay-form'
        ? (state.editingStayId ? 'Edit Stay' : 'New Stay')
        : (state.editingIdeaId ? 'Edit Idea' : 'New Idea');
    if (authChip && (state.firebaseReady || state.user)) authChip.classList.remove('hidden');
  }

  window.scrollTo({ top: 0, behavior: 'auto' });
}

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  ['schedule', 'stays', 'ideas', 'map', 'people'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'map') renderTripMap();
  if (tab === 'stays') renderStaysTab();
  if (tab === 'ideas') renderIdeasTab();
  if (tab === 'people') renderPeopleTab();
}

/* =============================================================
 * RENDER: TRIPS LIST
 * ============================================================= */
async function renderTripsList() {
  const trips = await getAllTrips();
  trips.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const grid = document.getElementById('trips-grid');
  const empty = document.getElementById('trips-empty');
  const syncing = document.getElementById('trips-syncing');

  if (!trips.length) {
    grid.innerHTML = '';
    // Signed in and still awaiting first snapshot? Show syncing.
    if (state.user && state.syncingInitial) {
      empty.classList.add('hidden');
      syncing.classList.remove('hidden');
    } else {
      syncing.classList.add('hidden');
      empty.classList.remove('hidden');
    }
    return;
  }
  empty.classList.add('hidden');
  syncing.classList.add('hidden');

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
  // Hydrate attachments so they render inline
  await Promise.all(acts.map(async a => {
    a._attachments = await getAttachmentsForParent('activity', a.id);
  }));
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

  await renderSchedule(trip, acts);
  if (state.currentTab === 'map') renderTripMap();
  if (state.currentTab === 'stays') renderStaysTab();
  if (state.currentTab === 'ideas') renderIdeasTab();
  if (state.currentTab === 'people') renderPeopleTab();
}

async function renderSchedule(trip, activities) {
  const container = document.getElementById('schedule');

  activities.sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    return (a.time || '').localeCompare(b.time || '');
  });

  const stays = await getStaysByTrip(trip.id);

  const byDay = {};
  for (let d = 1; d <= trip.days; d++) byDay[d] = [];
  activities.forEach(a => {
    if (a.day >= 1 && a.day <= trip.days) byDay[a.day].push(a);
  });

  // Pre-compute stay bindings per day
  const stayByDay = {}; // day -> [{ stay, kind: 'checkin'|'night'|'checkout' }]
  stays.forEach(s => {
    const cin = Math.max(1, s.checkInDay || 1);
    const nights = Math.max(1, s.nights || 1);
    for (let d = cin; d <= Math.min(trip.days, cin + nights); d++) {
      if (!stayByDay[d]) stayByDay[d] = [];
      let kind = 'night';
      if (d === cin) kind = 'checkin';
      else if (d === cin + nights) kind = 'checkout';
      stayByDay[d].push({ stay: s, kind });
    }
  });

  const parts = [];

  for (const d of Object.keys(byDay)) {
    const dayNum = Number(d);
    const acts = byDay[d];
    const dayCost = acts.reduce((s, a) => s + (Number(a.cost) || 0), 0);
    const dateLabel = trip.startDate ? addDaysLabel(trip.startDate, dayNum - 1) : '';
    const hasCoords = dayHasCoords(activities, dayNum);
    const dayStays = stayByDay[dayNum] || [];

    let inner = '';

    // Stay banners at the top of the day
    if (dayStays.length) {
      dayStays.forEach(({ stay, kind }) => {
        inner += renderStayBanner(stay, kind);
      });
    }

    if (!acts.length) {
      inner += `
        <div class="no-activities">
          <div>${dayStays.length ? 'No activities scheduled' : 'Nothing planned for this day'}</div>
        </div>`;
    } else {
      if (dayStays.length) inner += `<div class="day-section-label">Schedule</div>`;
      inner += acts.map(a => renderActivity(a)).join('');
    }

    const mapId = `day-map-${dayNum}`;

    parts.push(`
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
        <div class="day-add-footer">
          <button class="btn btn-sm btn-primary" data-action="add-day" data-day="${dayNum}">+ Add Activity to Day ${dayNum}</button>
        </div>
      </div>`);
  }

  container.innerHTML = parts.join('');

  // Wire buttons
  container.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'add-day') return openActivityForm(null, Number(btn.dataset.day));
      if (action === 'toggle-map') return toggleDayMap(Number(btn.dataset.day));
      if (action === 'edit-stay') return openStayForm(Number(btn.dataset.id));
      const id = Number(btn.dataset.id);
      if (action === 'edit') return openActivityForm(id);
      if (action === 'delete') return handleDeleteActivity(id);
      if (action === 'toggle') return handleToggleComplete(id);
      if (action === 'preview-attachment') return openAttachmentPreview(id);
    });
  });
}

function renderStayBanner(stay, kind) {
  let badge;
  if (kind === 'checkin') badge = `<span class="sb-badge checkin">Check-in ${stay.checkInTime || '15:00'}</span>`;
  else if (kind === 'checkout') badge = `<span class="sb-badge checkout">Check-out ${stay.checkOutTime || '12:00'}</span>`;
  else badge = `<span class="sb-badge">Night</span>`;

  return `
    <div class="stay-banner">
      <div class="sb-icon" aria-hidden="true">🏨</div>
      <div class="sb-text">Staying at <strong>${escapeHtml(stay.name)}</strong>${stay.address ? ` · <span class="subtle">${escapeHtml(stay.address)}</span>` : ''}</div>
      ${badge}
      <button class="btn btn-sm btn-ghost" data-action="edit-stay" data-id="${stay.id}" title="Edit stay">✎</button>
    </div>
  `;
}

function renderAttachmentChips(atts) {
  if (!atts || !atts.length) return '';
  return `<div class="attachment-chips">${atts.map(a => `
    <button type="button" class="attachment-chip" data-action="preview-attachment" data-id="${a.id}" title="${escapeHtml(a.name)}">
      <span aria-hidden="true">${attachmentIcon(a.type)}</span>
      <span class="att-chip-name">${escapeHtml(a.name)}</span>
    </button>
  `).join('')}</div>`;
}

function renderActivity(a) {
  const emoji = CATEGORY_EMOJI[a.category] || '📌';
  const endTime = a.time && a.duration ? addMinutesToTime(a.time, a.duration) : '';
  const atts = a._attachments || [];
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
        ${renderAttachmentChips(atts)}
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
  const stays = await getStaysByTrip(trip.id);
  const sorted = [...acts].sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    return (a.time || '').localeCompare(b.time || '');
  });
  const pts = [];
  sorted.forEach(a => activityToMapPoints(a, `Day ${a.day}`).forEach(p => pts.push(p)));
  // Add stays as pins (once each, at check-in day)
  stays.forEach(s => {
    if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) {
      pts.push({
        lat: s.lat, lng: s.lng,
        name: `🏨 ${s.name}`,
        time: `Check-in Day ${s.checkInDay || 1}`,
        location: s.address || '',
      });
    }
  });

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

/* =============================================================
 * STAYS TAB
 * ============================================================= */
async function renderStaysTab() {
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  const stays = await getStaysByTrip(trip.id);
  const list = document.getElementById('stays-list');
  const empty = document.getElementById('stays-empty');

  if (!stays.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // Hydrate attachments
  await Promise.all(stays.map(async s => {
    s._attachments = await getAttachmentsForParent('stay', s.id);
  }));

  stays.sort((a, b) => (a.checkInDay || 1) - (b.checkInDay || 1));

  list.innerHTML = stays.map(s => {
    const cin = s.checkInDay || 1;
    const nights = s.nights || 1;
    const cout = cin + nights;
    const cinLabel = trip.startDate ? addDaysLabel(trip.startDate, cin - 1) : `Day ${cin}`;
    const coutLabel = trip.startDate ? addDaysLabel(trip.startDate, cout - 1) : `Day ${cout}`;

    const meta = [];
    if (Number(s.cost) > 0) meta.push(`💵 ${fmtMoney(s.cost)}`);
    if (s.confirmation) meta.push(`🎫 ${escapeHtml(s.confirmation)}`);
    if (s.contact) meta.push(`📞 ${escapeHtml(s.contact)}`);
    if (s.website) meta.push(`🔗 <a href="${escapeHtml(s.website)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">Website</a>`);

    return `
      <div class="stay-card" data-stay-id="${s.id}">
        <div class="stay-head">
          <div class="stay-icon">🏨</div>
          <div class="stay-name">${escapeHtml(s.name)}</div>
          <div class="stay-nights">${nights} night${nights === 1 ? '' : 's'}</div>
        </div>
        ${s.address ? `<div class="stay-address">📍 ${escapeHtml(s.address)}</div>` : ''}
        <div class="stay-dates">
          <div class="sd-item">
            <span class="sd-label">Check-in</span>
            <span class="sd-value">${escapeHtml(cinLabel)}${s.checkInTime ? ' · ' + s.checkInTime : ''}</span>
          </div>
          <div class="sd-item">
            <span class="sd-label">Check-out</span>
            <span class="sd-value">${escapeHtml(coutLabel)}${s.checkOutTime ? ' · ' + s.checkOutTime : ''}</span>
          </div>
        </div>
        ${meta.length ? `<div class="stay-meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>` : ''}
        ${s.notes ? `<div class="stay-address">${escapeHtml(s.notes)}</div>` : ''}
        ${renderAttachmentChips(s._attachments)}
        <div class="stay-actions">
          <button class="btn btn-sm btn-ghost" data-action="edit-stay-full" data-id="${s.id}">Edit</button>
          <button class="btn btn-sm btn-danger-ghost" data-action="delete-stay" data-id="${s.id}">Delete</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      const action = btn.dataset.action;
      if (action === 'edit-stay-full') return openStayForm(id);
      if (action === 'delete-stay') return handleDeleteStay(id);
      if (action === 'preview-attachment') return openAttachmentPreview(id);
    });
  });
}

async function handleDeleteStay(id) {
  const s = await getStay(id);
  if (!s) return;
  if (!confirm(`Delete stay "${s.name}"?`)) return;
  await deleteStayDB(id);
  toast('Stay deleted', 'success');
  await renderStaysTab();
  await renderTripDetail();
}

/* =============================================================
 * IDEAS TAB
 * ============================================================= */
async function renderIdeasTab() {
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  const ideas = await getIdeasByTrip(trip.id);
  const list = document.getElementById('ideas-list');
  const empty = document.getElementById('ideas-empty');

  if (!ideas.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  ideas.sort((a, b) => (a.scheduledDays?.length ? 1 : 0) - (b.scheduledDays?.length ? 1 : 0)
                    || (b.createdAt || 0) - (a.createdAt || 0));

  list.innerHTML = ideas.map(i => {
    const emoji = CATEGORY_EMOJI[i.category] || '📌';
    const scheduled = Array.isArray(i.scheduledDays) && i.scheduledDays.length;
    return `
      <div class="idea-card ${scheduled ? 'scheduled' : ''}" data-idea-id="${i.id}">
        <div class="idea-head">
          <div class="idea-name"><span aria-hidden="true">${emoji}</span> ${escapeHtml(i.name)}</div>
          <span class="idea-cat">${CATEGORY_LABEL[i.category] || 'Other'}</span>
        </div>
        ${i.location ? `<div class="idea-loc">📍 ${escapeHtml(i.location)}</div>` : ''}
        ${i.notes ? `<div class="idea-notes">${escapeHtml(i.notes)}</div>` : ''}
        ${scheduled ? `<div class="idea-tags">${i.scheduledDays.map(d => `<span class="tag">Scheduled Day ${d}</span>`).join('')}</div>` : ''}
        <div class="idea-actions">
          <button class="btn btn-sm btn-primary" data-action="schedule-idea" data-id="${i.id}">Schedule</button>
          <button class="btn btn-sm btn-ghost" data-action="edit-idea" data-id="${i.id}">Edit</button>
          <button class="btn btn-sm btn-danger-ghost" data-action="delete-idea" data-id="${i.id}">Delete</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      const action = btn.dataset.action;
      if (action === 'schedule-idea') return openScheduleIdea(id);
      if (action === 'edit-idea') return openIdeaForm(id);
      if (action === 'delete-idea') return handleDeleteIdea(id);
    });
  });
}

async function handleDeleteIdea(id) {
  const i = await getIdea(id);
  if (!i) return;
  if (!confirm(`Delete idea "${i.name}"?`)) return;
  await deleteIdeaDB(id);
  toast('Idea deleted', 'success');
  await renderIdeasTab();
}

/* =============================================================
 * PEOPLE TAB
 * ============================================================= */
async function renderPeopleTab() {
  const notice = document.getElementById('people-signin-notice');
  const content = document.getElementById('people-content');

  if (!state.user) {
    notice.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }
  notice.classList.add('hidden');
  content.classList.remove('hidden');

  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  const list = document.getElementById('people-list');

  const isOwner = trip.ownerUid === state.user.uid;
  const rows = [];

  // Owner row
  const ownerLabel = isOwner
    ? (state.user.email || 'You')
    : (trip.ownerEmail || 'Owner');
  const ownerAvatarInitial = (ownerLabel || 'O').charAt(0).toUpperCase();
  const ownerAvatarSrc = isOwner && state.user.photoURL
    ? `<img src="${state.user.photoURL}" referrerpolicy="no-referrer" alt="" />`
    : ownerAvatarInitial;

  rows.push(`
    <div class="person-row">
      <div class="person-avatar">${ownerAvatarSrc}</div>
      <div class="person-info">
        <div class="person-email">${escapeHtml(ownerLabel)}${isOwner ? ' (you)' : ''}</div>
        <div class="person-role">Owner · full access</div>
      </div>
      <span class="person-badge">Owner</span>
    </div>
  `);

  const collabs = Array.isArray(trip.collaborators) ? trip.collaborators : [];
  collabs.forEach(email => {
    const isMe = state.user.email && state.user.email.toLowerCase() === email.toLowerCase();
    rows.push(`
      <div class="person-row">
        <div class="person-avatar">${(email || '?').charAt(0).toUpperCase()}</div>
        <div class="person-info">
          <div class="person-email">${escapeHtml(email)}${isMe ? ' (you)' : ''}</div>
          <div class="person-role">Editor · full access</div>
        </div>
        ${isOwner ? `<button class="btn btn-sm btn-danger-ghost" data-action="remove-collab" data-email="${escapeHtml(email)}">Remove</button>` : `<span class="person-badge">Editor</span>`}
      </div>
    `);
  });

  list.innerHTML = rows.join('');

  list.querySelectorAll('button[data-action="remove-collab"]').forEach(btn => {
    btn.addEventListener('click', () => handleRemoveCollaborator(btn.dataset.email));
  });

  // Show / hide invite form based on ownership
  const inviteForm = document.getElementById('invite-form');
  if (inviteForm) {
    inviteForm.style.display = isOwner ? '' : 'none';
    if (!isOwner && inviteForm.nextElementSibling) {
      inviteForm.nextElementSibling.style.display = 'none';
    }
  }

  // Join code UI
  await renderJoinCodeUI();
}

async function handleInviteCollaborator(e) {
  e.preventDefault();
  if (!state.user) { toast('Sign in first', 'error'); return; }
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  if (trip.ownerUid !== state.user.uid) {
    toast('Only the trip owner can invite', 'error');
    return;
  }
  const emailInput = document.getElementById('invite-email');
  const email = (emailInput.value || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast('Enter a valid email', 'error');
    return;
  }
  if (email === (state.user.email || '').toLowerCase()) {
    toast("You're already the owner", 'error');
    return;
  }
  const list = Array.isArray(trip.collaborators) ? [...trip.collaborators] : [];
  if (list.includes(email)) { toast('Already invited', 'error'); return; }
  list.push(email);

  const inviteBtn = document.querySelector('#invite-form button[type="submit"]');
  if (inviteBtn) { inviteBtn.disabled = true; inviteBtn.textContent = 'Inviting…'; }
  try {
    await saveTrip(
      { ...trip, collaborators: list, ownerEmail: (state.user.email || '').toLowerCase() || null },
      { awaitCloud: true }
    );
    emailInput.value = '';
    toast(`Invited ${email}`, 'success');
  } catch (err) {
    console.error(err);
    toast('Invite failed: ' + (err.message || 'unknown'), 'error');
  } finally {
    if (inviteBtn) { inviteBtn.disabled = false; inviteBtn.textContent = 'Invite'; }
  }
  await renderPeopleTab();
}

async function handleRemoveCollaborator(email) {
  if (!confirm(`Remove ${email}? They will lose access to this trip.`)) return;
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  const list = (trip.collaborators || []).filter(e => e.toLowerCase() !== email.toLowerCase());
  try {
    await saveTrip({ ...trip, collaborators: list }, { awaitCloud: true });
    toast('Collaborator removed', 'success');
  } catch (err) {
    toast('Remove failed: ' + (err.message || 'unknown'), 'error');
  }
  await renderPeopleTab();
}

/* =============================================================
 * TRIP CODE (JOIN BY CODE)
 *
 * We keep a small side-collection `joinCodes/{CODE}` -> { tripId, ownerUid }.
 * The trip doc also stores `joinCode` so we can display/revoke.
 * Firestore rules:
 *   - joinCodes: any signed-in user can `get` (to look up a code)
 *                only the owner can create/delete their code doc
 *   - trips: existing rules + `isSelfJoinViaCode` lets a signed-in user
 *            add ONLY their own email to `collaborators` if the trip's
 *            joinCode matches an existing joinCodes doc they can read
 * ============================================================= */

// Human-readable random codes: prefix (from trip name if possible) + 4-char base32
function randomCode(prefix) {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/1/O/I confusion
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += alpha[bytes[i] % alpha.length];
  const p = (prefix || 'TRIP').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'TRIP';
  return `${p}-${suffix}`;
}

function joinCodesDoc(code) {
  return state.firestore.collection('joinCodes').doc(code.toUpperCase());
}

async function renderJoinCodeUI() {
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  const emptyEl = document.getElementById('join-code-empty');
  const activeEl = document.getElementById('join-code-active');
  const displayEl = document.getElementById('join-code-display');
  const genBtn = document.getElementById('join-code-generate');
  const revBtn = document.getElementById('join-code-revoke');
  const isOwner = trip.ownerUid === state.user?.uid;

  const wrap = document.getElementById('join-code-block');
  wrap.style.display = isOwner ? '' : 'none';
  if (!isOwner) return;

  if (trip.joinCode) {
    emptyEl.classList.add('hidden');
    activeEl.classList.remove('hidden');
    displayEl.textContent = trip.joinCode;
    genBtn.textContent = 'Regenerate code';
    revBtn.classList.remove('hidden');
  } else {
    emptyEl.classList.remove('hidden');
    activeEl.classList.add('hidden');
    genBtn.textContent = 'Generate code';
    revBtn.classList.add('hidden');
  }
}

async function handleGenerateJoinCode() {
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;
  if (trip.ownerUid !== state.user?.uid) {
    toast('Only the owner can create a code', 'error');
    return;
  }
  const genBtn = document.getElementById('join-code-generate');
  const prev = genBtn.textContent;
  genBtn.disabled = true; genBtn.textContent = 'Generating…';

  try {
    // If there's an old code, delete its lookup doc first
    if (trip.joinCode) {
      try { await joinCodesDoc(trip.joinCode).delete(); } catch (e) { /* fine */ }
    }
    // Try up to 5 codes in case of collision
    let code, ok = false;
    for (let i = 0; i < 5; i++) {
      code = randomCode(trip.name);
      const existing = await joinCodesDoc(code).get();
      if (!existing.exists) { ok = true; break; }
    }
    if (!ok) throw new Error('Could not generate a unique code');

    // ORDER MATTERS to avoid the "revoked" race:
    // 1. Write trip.joinCode FIRST and wait for server ack
    // 2. THEN create the joinCodes lookup doc
    // This way, any invitee who successfully reads joinCodes/{CODE}
    // is guaranteed to see the matching trip.joinCode field.
    await saveTrip({ ...trip, joinCode: code }, { awaitCloud: true });

    await joinCodesDoc(code).set({
      tripId: trip.id,
      ownerUid: state.user.uid,
      code: code,
      createdAt: Date.now(),
    });
    try { await state.firestore.waitForPendingWrites(); } catch (e) {}

    // Verify the write landed by reading trip back from server
    try {
      const check = await tripDoc(trip.id).get({ source: 'server' });
      if (check.exists && check.data().joinCode !== code) {
        console.warn('Trip joinCode did not match after generate:', check.data().joinCode, 'vs', code);
      }
    } catch (e) { /* non-fatal */ }

    toast('Code ready to share', 'success');
    await renderJoinCodeUI();
  } catch (err) {
    console.error('Generate code failed:', err);
    toast('Failed: ' + (err.code || err.message || 'unknown'), 'error');
  } finally {
    genBtn.disabled = false; genBtn.textContent = prev;
  }
}

async function handleRevokeJoinCode() {
  const trip = await getTrip(state.currentTripId);
  if (!trip || !trip.joinCode) return;
  if (!confirm('Revoke this trip code? Nobody will be able to join with it anymore.')) return;

  try {
    // Delete lookup doc, then clear from trip
    try { await joinCodesDoc(trip.joinCode).delete(); } catch (e) { /* fine */ }
    await saveTrip({ ...trip, joinCode: null }, { awaitCloud: true });
    toast('Code revoked', 'success');
    await renderJoinCodeUI();
  } catch (err) {
    toast('Failed: ' + (err.code || err.message || 'unknown'), 'error');
  }
}

async function handleCopyJoinCode() {
  const trip = await getTrip(state.currentTripId);
  if (!trip || !trip.joinCode) return;
  try {
    await navigator.clipboard.writeText(trip.joinCode);
    toast('Code copied', 'success');
  } catch {
    // fallback: select the display
    const el = document.getElementById('join-code-display');
    const range = document.createRange();
    range.selectNode(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { document.execCommand('copy'); toast('Code copied', 'success'); }
    catch { toast('Long-press the code to copy', ''); }
  }
}

async function handleShareJoinCode() {
  const trip = await getTrip(state.currentTripId);
  if (!trip || !trip.joinCode) return;
  const text = `Join my trip "${trip.name}" on Itinerary Planner.\n\nTrip code: ${trip.joinCode}\n\nSign in at ${window.location.origin}${window.location.pathname} and enter the code on your Trips screen.`;
  try {
    if (navigator.share) {
      await navigator.share({ title: `Join "${trip.name}"`, text });
    } else {
      await navigator.clipboard.writeText(text);
      toast('Invite message copied', 'success');
    }
  } catch (err) {
    if (err.name !== 'AbortError') console.warn(err);
  }
}

/* -------- Join by code (invitee side) -------- */
async function handleJoinByCode(e) {
  e.preventDefault();
  if (!state.user) { toast('Sign in first', 'error'); return; }
  let raw = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (!raw) return;

  const submitBtn = document.querySelector('#join-form button[type="submit"]');
  submitBtn.disabled = true; submitBtn.textContent = 'Joining…';

  try {
    // Try code as-typed, and if not found, try alt variants (with/without dash)
    const attempts = [raw];
    if (!raw.includes('-') && raw.length >= 5) {
      // Insert dash so PREFIX-XXXX lookup works when user typed no dash
      attempts.push(raw.slice(0, raw.length - 4) + '-' + raw.slice(-4));
    }
    if (raw.includes('-')) attempts.push(raw.replace(/-/g, ''));

    let snap = null;
    for (const c of attempts) {
      const s = await joinCodesDoc(c).get();
      if (s.exists) { snap = s; raw = c; break; }
    }
    if (!snap) {
      toast('Code not found — check spelling or ask for a new one', 'error');
      return;
    }
    const info = snap.data();
    const tripId = Number(info.tripId);

    // 2) Fetch the trip so we know current collaborators.
    // Force server-fetch to avoid stale cached data on the invitee's device.
    let tripSnap;
    try {
      tripSnap = await tripDoc(tripId).get({ source: 'server' });
    } catch (e) {
      tripSnap = await tripDoc(tripId).get();
    }
    if (!tripSnap.exists) {
      toast('Trip no longer exists', 'error');
      return;
    }
    const tripData = tripSnap.data();

    console.log('[join] Trip data:', {
      name: tripData.name, joinCode: tripData.joinCode,
      ownerUid: tripData.ownerUid, myUid: state.user.uid, myEmail,
      typed: raw,
    });

    // The joinCodes doc is our source of truth. Only reject if the trip
    // explicitly shows a *different* joinCode (i.e. owner regenerated).
    // If joinCode is missing on the trip but the joinCodes doc exists, allow —
    // it's likely a propagation delay.
    if (tripData.joinCode && String(tripData.joinCode).toUpperCase() !== raw.toUpperCase()) {
      toast(`Code mismatch — trip says "${tripData.joinCode}" but you typed "${raw}". Ask the owner for the current code.`, 'error');
      return;
    }

    const myEmail = (state.user.email || '').toLowerCase();
    if (!myEmail) { toast('No email on account', 'error'); return; }

    // 3) If already the owner or collaborator, deep-link
    if (tripData.ownerUid === state.user.uid
        || (tripData.collaborators || []).map(e => e.toLowerCase()).includes(myEmail)) {
      toast(`You're already in "${tripData.name}"`, 'success');
      // Seed local so it renders even if listener hasn't fired yet
      await reqP(tx(STORE_TRIPS, 'readwrite').put({ ...tripData, id: tripId, updatedAt: Date.now() }));
      state.currentTripId = tripId;
      hideJoinPanel();
      setTimeout(() => { switchView('trip-detail'); switchTab('schedule'); renderTripDetail(); }, 200);
      return;
    }

    // 4) Add ourselves as collaborator via a minimal update.
    // Rules require: joinCode unchanged, ownerUid unchanged, collaborators = old + me.
    const newCollabs = Array.isArray(tripData.collaborators) ? [...tripData.collaborators] : [];
    newCollabs.push(myEmail);
    // Ensure joinCode is present in the trip doc so the rule can validate.
    // If it's somehow missing (propagation lag), use the typed code — the
    // joinCodes lookup already confirmed it's valid.
    const codeForWrite = tripData.joinCode || raw;
    console.log('[join] Writing collab update:', { tripId, newCollabs, codeForWrite });
    await tripDoc(tripId).update({
      collaborators: newCollabs,
      joinCode: codeForWrite,
      ownerUid: tripData.ownerUid,
      updatedAt: Date.now(),
    });
    try { await state.firestore.waitForPendingWrites(); } catch (e) {}

    toast(`Joined "${tripData.name}"!`, 'success');
    hideJoinPanel();
    // Seed the trip into local IDB so the detail view can render immediately,
    // then let the listener take over for live updates.
    const seed = {
      ...tripData,
      id: tripId,
      collaborators: newCollabs,
      _fromCloud: true,
    };
    delete seed._fromCloud;  // treat as owned locally
    await reqP(tx(STORE_TRIPS, 'readwrite').put({ ...seed, updatedAt: Date.now() }));
    state.currentTripId = tripId;
    setTimeout(() => {
      switchView('trip-detail');
      switchTab('schedule');
      renderTripDetail();
    }, 300);
  } catch (err) {
    console.error(err);
    const msg = err.code === 'permission-denied'
      ? "Blocked by Firestore rules — make sure you've published the latest rules from README (Section 5)."
      : (err.code || err.message || 'unknown error');
    toast('Join failed: ' + msg, 'error');
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = 'Join';
  }
}

function showJoinPanel() {
  document.getElementById('join-panel').classList.remove('hidden');
  setTimeout(() => document.getElementById('join-code-input').focus(), 60);
}
function hideJoinPanel() {
  document.getElementById('join-panel').classList.add('hidden');
  document.getElementById('join-code-input').value = '';
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
  const stays = await getStaysByTrip(trip.id);
  const totalCost = acts.reduce((s, a) => s + (Number(a.cost) || 0), 0)
                  + stays.reduce((s, x) => s + (Number(x.cost) || 0), 0);

  // Sort
  acts.sort((a, b) => {
    if (a.day !== b.day) return a.day - b.day;
    return (a.time || '').localeCompare(b.time || '');
  });

  const byDay = {};
  for (let d = 1; d <= trip.days; d++) byDay[d] = [];
  acts.forEach(a => { if (a.day >= 1 && a.day <= trip.days) byDay[a.day].push(a); });

  // Map stays -> per-day banners
  const stayByDay = {};
  stays.forEach(s => {
    const cin = Math.max(1, s.checkInDay || 1);
    const nights = Math.max(1, s.nights || 1);
    for (let d = cin; d <= Math.min(trip.days, cin + nights); d++) {
      if (!stayByDay[d]) stayByDay[d] = [];
      stayByDay[d].push({ stay: s, isCheckIn: d === cin, isCheckOut: d === cin + nights });
    }
  });

  const dayHtml = Object.keys(byDay).map(d => {
    const dayNum = Number(d);
    const others = byDay[d];
    const dayCost = others.reduce((s, a) => s + (Number(a.cost) || 0), 0);
    const dateLabel = trip.startDate ? addDaysLabel(trip.startDate, dayNum - 1) : '';
    const dayStays = stayByDay[dayNum] || [];

    let staysHtml = '';
    if (dayStays.length) {
      staysHtml = `<div class="pdf-section-label">Stay</div>` + dayStays.map(({ stay: a, isCheckIn, isCheckOut }) => {
        if (isCheckIn) {
          return `
            <div class="pdf-stay">
              <div class="pdf-stay-name">🏨 ${escapeHtml(a.name)} <span style="color:#0f9d58;font-size:9.5px;background:#e6f4ec;padding:1px 6px;border-radius:8px;margin-left:6px">CHECK-IN</span></div>
              ${a.address ? `<div class="pdf-stay-addr">${escapeHtml(a.address)}</div>` : ''}
              <div class="pdf-stay-meta">
                ${a.checkInTime ? `<span><b>Check-in:</b> ${escapeHtml(a.checkInTime)}</span>` : ''}
                <span><b>Nights:</b> ${a.nights}</span>
                ${a.confirmation ? `<span><b>Booking:</b> ${escapeHtml(a.confirmation)}</span>` : ''}
                ${a.contact ? `<span><b>Contact:</b> ${escapeHtml(a.contact)}</span>` : ''}
                ${Number(a.cost) > 0 ? `<span><b>Cost:</b> ${fmtMoney(a.cost)}</span>` : ''}
              </div>
              ${a.notes ? `<div class="pdf-stay-addr" style="margin-top:4px">${escapeHtml(a.notes)}</div>` : ''}
            </div>`;
        }
        if (isCheckOut) {
          return `<div class="pdf-stay" style="background:#fdf2df;border-color:#f0d78c"><div class="pdf-stay-name">🏨 Check out from ${escapeHtml(a.name)}${a.checkOutTime ? ' · ' + escapeHtml(a.checkOutTime) : ''}</div></div>`;
        }
        return `<div class="pdf-stay" style="padding:6px 12px;font-size:11px"><b>🏨 Staying at ${escapeHtml(a.name)}</b></div>`;
      }).join('');
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

    if (!dayStays.length && !others.length) {
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
  const stays = await getStaysByTrip(trip.id);
  const ideas = await getIdeasByTrip(trip.id);
  const payload = {
    name: trip.name, startDate: trip.startDate, days: trip.days,
    description: trip.description || '', budget: trip.budget || 0,
    locationName: trip.locationName || '', lat: trip.lat, lng: trip.lng,
    stays: stays.map(s => ({
      name: s.name, checkInDay: s.checkInDay, nights: s.nights,
      checkInTime: s.checkInTime, checkOutTime: s.checkOutTime,
      address: s.address, cost: s.cost, confirmation: s.confirmation,
      contact: s.contact, website: s.website, notes: s.notes,
      lat: s.lat, lng: s.lng,
    })),
    ideas: ideas.map(i => ({
      name: i.name, category: i.category, location: i.location, notes: i.notes,
      cost: i.cost, duration: i.duration, lat: i.lat, lng: i.lng,
      scheduledDays: i.scheduledDays,
    })),
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
  state.pendingAttachments = [];
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
    // Accommodation fields moved to the Stays tab — legacy activities keep the data but don't show fields
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
    // Load attachments for editing
    const existing = await getAttachmentsForParent('activity', activityId);
    state.pendingAttachments = existing.map(x => ({ ...x, _existing: true }));
    renderPendingAttachments('af-attachments-list', state.pendingAttachments);
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
    // No accommodation fields in activity form anymore
    state.pickedTransportFromCoord = null;
    state.pickedTransportToCoord = null;
    updateCategoryFieldsVisibility();
    renderPendingAttachments('af-attachments-list', []);
  }

  switchView('activity-form');
  setTimeout(() => document.getElementById('af-name').focus(), 80);
}

function updateCategoryFieldsVisibility() {
  const cat = document.getElementById('af-category').value;
  document.getElementById('transport-fields').classList.toggle('show', cat === 'transport');
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
  };

  let activityId;
  if (state.editingActivityId) {
    const existing = await getActivity(state.editingActivityId);
    await saveActivity({ ...existing, ...payload });
    activityId = state.editingActivityId;
    toast('Activity updated', 'success');
  } else {
    activityId = newId();
    await saveActivity({
      id: activityId,
      ...payload,
      completed: false,
      createdAt: Date.now(),
    });
    toast('Activity added', 'success');
  }

  // Persist attachments
  await commitPendingAttachments('activity', activityId, trip.id);

  state.editingActivityId = null;
  state.pendingAttachments = [];
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
 * STAY FORM
 * ============================================================= */
async function openStayForm(stayId = null) {
  state.editingStayId = stayId;
  state.pickedStayCoord = null;
  state.pendingAttachments = [];
  const form = document.getElementById('stay-form');
  form.reset();
  document.getElementById('sf-address-results').classList.add('hidden');

  const trip = await getTrip(state.currentTripId);
  if (!trip) { switchView('trips'); return; }
  document.getElementById('sf-checkin-day').max = trip.days;

  if (stayId) {
    const s = await getStay(stayId);
    if (!s) return;
    document.getElementById('stay-form-title').textContent = 'Edit Stay';
    document.getElementById('sf-name').value = s.name || '';
    document.getElementById('sf-checkin-day').value = s.checkInDay || 1;
    document.getElementById('sf-nights').value = s.nights || 1;
    document.getElementById('sf-checkin-time').value = s.checkInTime || '15:00';
    document.getElementById('sf-checkout-time').value = s.checkOutTime || '12:00';
    document.getElementById('sf-address').value = s.address || '';
    document.getElementById('sf-cost').value = s.cost || 0;
    document.getElementById('sf-confirmation').value = s.confirmation || '';
    document.getElementById('sf-contact').value = s.contact || '';
    document.getElementById('sf-website').value = s.website || '';
    document.getElementById('sf-notes').value = s.notes || '';
    if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) {
      state.pickedStayCoord = { lat: s.lat, lng: s.lng };
    }
    const existing = await getAttachmentsForParent('stay', stayId);
    renderPendingAttachments('sf-attachments-list', existing.map(a => ({ ...a, _existing: true })));
    state.pendingAttachments = existing.map(a => ({ ...a, _existing: true }));
  } else {
    document.getElementById('stay-form-title').textContent = 'Add Stay';
    document.getElementById('sf-checkin-day').value = 1;
    document.getElementById('sf-nights').value = 1;
    document.getElementById('sf-checkin-time').value = '15:00';
    document.getElementById('sf-checkout-time').value = '12:00';
    document.getElementById('sf-cost').value = 0;
    renderPendingAttachments('sf-attachments-list', []);
  }

  switchView('stay-form');
  setTimeout(() => document.getElementById('sf-name').focus(), 80);
}

async function handleStayFormSubmit(e) {
  e.preventDefault();
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;

  const name = document.getElementById('sf-name').value.trim();
  const checkInDay = parseInt(document.getElementById('sf-checkin-day').value, 10);
  const nights = parseInt(document.getElementById('sf-nights').value, 10);
  if (!name || !checkInDay || !nights || nights < 1) {
    toast('Please fill all required fields', 'error');
    return;
  }
  if (checkInDay < 1 || checkInDay > trip.days) {
    toast(`Check-in day must be 1–${trip.days}`, 'error');
    return;
  }

  const address = document.getElementById('sf-address').value.trim();
  let lat = null, lng = null;
  if (state.pickedStayCoord) { lat = state.pickedStayCoord.lat; lng = state.pickedStayCoord.lng; }
  else if (address) {
    try {
      const r = await window.MapMod.geocode(address, 1);
      if (r.length) { lat = r[0].lat; lng = r[0].lng; }
    } catch (e) {}
  }

  const payload = {
    tripId: trip.id,
    name,
    checkInDay,
    nights,
    checkInTime: document.getElementById('sf-checkin-time').value,
    checkOutTime: document.getElementById('sf-checkout-time').value,
    address,
    cost: parseFloat(document.getElementById('sf-cost').value) || 0,
    confirmation: document.getElementById('sf-confirmation').value.trim(),
    contact: document.getElementById('sf-contact').value.trim(),
    website: document.getElementById('sf-website').value.trim(),
    notes: document.getElementById('sf-notes').value.trim(),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };

  let stayId;
  if (state.editingStayId) {
    const existing = await getStay(state.editingStayId);
    await saveStay({ ...existing, ...payload });
    stayId = state.editingStayId;
    toast('Stay updated', 'success');
  } else {
    stayId = newId();
    await saveStay({ id: stayId, ...payload, createdAt: Date.now() });
    toast('Stay added', 'success');
  }

  // Persist pending attachments
  await commitPendingAttachments('stay', stayId, trip.id);

  state.editingStayId = null;
  state.pendingAttachments = [];
  await renderTripDetail();
  await renderStaysTab();
  switchView('trip-detail');
  switchTab('stays');
}

/* =============================================================
 * IDEA FORM
 * ============================================================= */
async function openIdeaForm(ideaId = null) {
  state.editingIdeaId = ideaId;
  state.pickedIdeaCoord = null;
  const form = document.getElementById('idea-form');
  form.reset();
  document.getElementById('if-location-results').classList.add('hidden');

  const trip = await getTrip(state.currentTripId);
  if (!trip) return;

  if (ideaId) {
    const i = await getIdea(ideaId);
    if (!i) return;
    document.getElementById('idea-form-title').textContent = 'Edit Idea';
    document.getElementById('if-name').value = i.name || '';
    document.getElementById('if-category').value = i.category || 'sightseeing';
    document.getElementById('if-location').value = i.location || '';
    document.getElementById('if-notes').value = i.notes || '';
    document.getElementById('if-cost').value = i.cost || '';
    document.getElementById('if-duration').value = i.duration || '';
    if (Number.isFinite(i.lat) && Number.isFinite(i.lng)) {
      state.pickedIdeaCoord = { lat: i.lat, lng: i.lng };
    }
  } else {
    document.getElementById('idea-form-title').textContent = 'Add Idea';
    document.getElementById('if-category').value = 'sightseeing';
  }

  switchView('idea-form');
  setTimeout(() => document.getElementById('if-name').focus(), 80);
}

async function handleIdeaFormSubmit(e) {
  e.preventDefault();
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;

  const name = document.getElementById('if-name').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }

  const location = document.getElementById('if-location').value.trim();
  let lat = null, lng = null;
  if (state.pickedIdeaCoord) { lat = state.pickedIdeaCoord.lat; lng = state.pickedIdeaCoord.lng; }
  else if (location) {
    try {
      const r = await window.MapMod.geocode(location, 1);
      if (r.length) { lat = r[0].lat; lng = r[0].lng; }
    } catch (e) {}
  }

  const payload = {
    tripId: trip.id,
    name,
    category: document.getElementById('if-category').value,
    location,
    notes: document.getElementById('if-notes').value.trim(),
    cost: parseFloat(document.getElementById('if-cost').value) || 0,
    duration: parseInt(document.getElementById('if-duration').value, 10) || 0,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };

  if (state.editingIdeaId) {
    const existing = await getIdea(state.editingIdeaId);
    await saveIdea({ ...existing, ...payload });
    toast('Idea updated', 'success');
  } else {
    await saveIdea({
      id: newId(),
      ...payload,
      scheduledDays: [],
      createdAt: Date.now(),
    });
    toast('Idea saved', 'success');
  }

  state.editingIdeaId = null;
  switchView('trip-detail');
  switchTab('ideas');
  await renderIdeasTab();
}

/* =============================================================
 * SCHEDULE IDEA (promote to activity)
 * ============================================================= */
async function openScheduleIdea(ideaId) {
  const idea = await getIdea(ideaId);
  if (!idea) return;
  const trip = await getTrip(state.currentTripId);
  if (!trip) return;

  state.schedulingIdeaId = ideaId;
  document.getElementById('sim-idea-name').textContent = idea.name;
  document.getElementById('sim-day').max = trip.days;
  document.getElementById('sim-day').value = 1;
  document.getElementById('sim-time').value = '09:00';
  document.getElementById('schedule-idea-modal').classList.remove('hidden');
}

function closeScheduleIdeaModal() {
  document.getElementById('schedule-idea-modal').classList.add('hidden');
  state.schedulingIdeaId = null;
}

async function handleScheduleIdeaSubmit(e) {
  e.preventDefault();
  const idea = await getIdea(state.schedulingIdeaId);
  if (!idea) return;
  const trip = await getTrip(state.currentTripId);
  const day = parseInt(document.getElementById('sim-day').value, 10);
  const time = document.getElementById('sim-time').value;
  if (day < 1 || day > trip.days) { toast('Day out of range', 'error'); return; }

  const activity = {
    id: newId(),
    tripId: trip.id,
    name: idea.name,
    description: idea.notes || '',
    day, time,
    duration: idea.duration || 60,
    cost: idea.cost || 0,
    travelTime: 0,
    location: idea.location || '',
    category: idea.category || 'sightseeing',
    lat: idea.lat || null,
    lng: idea.lng || null,
    fromIdeaId: idea.id,
    completed: false,
    createdAt: Date.now(),
  };
  await saveActivity(activity);

  // Mark idea as scheduled
  const scheduledDays = Array.isArray(idea.scheduledDays) ? [...idea.scheduledDays] : [];
  if (!scheduledDays.includes(day)) scheduledDays.push(day);
  await saveIdea({ ...idea, scheduledDays });

  toast(`Scheduled to Day ${day}`, 'success');
  closeScheduleIdeaModal();
  await renderIdeasTab();
  await renderTripDetail();
  switchTab('schedule');
}

/* =============================================================
 * ATTACHMENTS
 * ============================================================= */
function attachmentIcon(type) {
  if (!type) return '📎';
  if (type.startsWith('image/')) return '🖼️';
  if (type === 'application/pdf') return '📄';
  if (type.startsWith('video/')) return '🎬';
  if (type.startsWith('audio/')) return '🎵';
  if (type.includes('word') || type.includes('document')) return '📝';
  if (type.includes('sheet') || type.includes('excel')) return '📊';
  return '📎';
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderPendingAttachments(containerId, items) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!items.length) { el.innerHTML = ''; return; }
  el.innerHTML = items.map((a, idx) => `
    <div class="attachment-row" data-idx="${idx}">
      <div class="att-icon">${attachmentIcon(a.type)}</div>
      <div class="att-info" data-action="preview-pending" data-idx="${idx}">
        <div class="att-name">${escapeHtml(a.name)}</div>
        <div class="att-size">${fmtBytes(a.size)}${a._existing ? '' : ' · not saved yet'}</div>
      </div>
      <button type="button" class="att-remove" data-action="remove-pending" data-idx="${idx}" title="Remove">✕</button>
    </div>
  `).join('');
  el.querySelectorAll('button[data-action="remove-pending"], .att-info[data-action="preview-pending"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = Number(btn.dataset.idx);
      if (btn.dataset.action === 'remove-pending') {
        e.stopPropagation();
        state.pendingAttachments.splice(idx, 1);
        renderPendingAttachments(containerId, state.pendingAttachments);
      } else {
        openAttachmentPreviewFromBlob(state.pendingAttachments[idx]);
      }
    });
  });
}

async function handleAttachmentPick(fileInputId, listContainerId, e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const f of files) {
    if (f.size > MAX_ATTACHMENT_SIZE) {
      toast(`${f.name} is over 5 MB — skipped`, 'error');
      continue;
    }
    state.pendingAttachments.push({
      name: f.name,
      type: f.type || 'application/octet-stream',
      size: f.size,
      blob: f,
    });
  }
  renderPendingAttachments(listContainerId, state.pendingAttachments);
}

async function commitPendingAttachments(kind, parentId, tripId) {
  // Any pending that are NOT _existing → save. Existing ones already in DB.
  // Also, if _existing was removed from the array, delete from DB.
  const existingOnServer = await getAttachmentsForParent(kind, parentId);
  const keptIds = new Set(state.pendingAttachments.filter(a => a._existing).map(a => a.id));
  for (const srv of existingOnServer) {
    if (!keptIds.has(srv.id)) await deleteAttachment(srv.id);
  }
  for (const a of state.pendingAttachments) {
    if (a._existing) continue;
    await saveAttachment({
      id: newId() + Math.floor(Math.random() * 1000),
      tripId,
      parentKey: parentKey(kind, parentId),
      parentKind: kind,
      parentId,
      name: a.name,
      type: a.type,
      size: a.size,
      blob: a.blob,
      createdAt: Date.now(),
    });
  }
}

async function openAttachmentPreview(id) {
  const a = await getAttachment(id);
  if (!a) return;
  openAttachmentPreviewFromBlob(a);
}

function openAttachmentPreviewFromBlob(a) {
  const modal = document.getElementById('attach-preview-modal');
  const nameEl = document.getElementById('preview-name');
  const dl = document.getElementById('preview-download');
  const body = document.getElementById('preview-body');
  nameEl.textContent = a.name;
  const url = URL.createObjectURL(a.blob);
  dl.href = url;
  dl.download = a.name;

  body.innerHTML = '';
  if (a.type && a.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = a.name;
    body.appendChild(img);
  } else if (a.type === 'application/pdf') {
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.title = a.name;
    body.appendChild(iframe);
  } else if (a.type && a.type.startsWith('text/')) {
    a.blob.text().then(txt => {
      const pre = document.createElement('pre');
      pre.style.padding = '16px';
      pre.style.whiteSpace = 'pre-wrap';
      pre.style.wordBreak = 'break-word';
      pre.style.margin = '0';
      pre.style.fontFamily = 'var(--font-mono)';
      pre.style.fontSize = '12.5px';
      pre.textContent = txt;
      body.appendChild(pre);
    });
  } else {
    const fb = document.createElement('div');
    fb.className = 'preview-fallback';
    fb.innerHTML = `<div style="font-size:36px;margin-bottom:8px">${attachmentIcon(a.type)}</div>
      <div>Preview not supported.</div>
      <div class="subtle">Use Download to open in another app.</div>`;
    body.appendChild(fb);
  }

  modal.classList.remove('hidden');
  // Revoke URL when closed
  modal._activeUrl = url;
}
function closeAttachmentPreview() {
  const modal = document.getElementById('attach-preview-modal');
  if (modal._activeUrl) {
    URL.revokeObjectURL(modal._activeUrl);
    modal._activeUrl = null;
  }
  modal.classList.add('hidden');
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
      if (Array.isArray(raw.stays)) {
        for (const s of raw.stays) {
          if (!s || !s.name) continue;
          await new Promise(r => setTimeout(r, 1));
          await saveStay({
            id: newId(),
            tripId: trip.id,
            name: String(s.name),
            checkInDay: parseInt(s.checkInDay, 10) || 1,
            nights: parseInt(s.nights, 10) || 1,
            checkInTime: String(s.checkInTime || '15:00'),
            checkOutTime: String(s.checkOutTime || '12:00'),
            address: String(s.address || ''),
            cost: parseFloat(s.cost) || 0,
            confirmation: String(s.confirmation || ''),
            contact: String(s.contact || ''),
            website: String(s.website || ''),
            notes: String(s.notes || ''),
            lat: Number.isFinite(parseFloat(s.lat)) ? parseFloat(s.lat) : null,
            lng: Number.isFinite(parseFloat(s.lng)) ? parseFloat(s.lng) : null,
            createdAt: Date.now(),
          });
        }
      }
      if (Array.isArray(raw.ideas)) {
        for (const i of raw.ideas) {
          if (!i || !i.name) continue;
          await new Promise(r => setTimeout(r, 1));
          await saveIdea({
            id: newId(),
            tripId: trip.id,
            name: String(i.name),
            category: String(i.category || 'sightseeing'),
            location: String(i.location || ''),
            notes: String(i.notes || ''),
            cost: parseFloat(i.cost) || 0,
            duration: parseInt(i.duration, 10) || 0,
            lat: Number.isFinite(parseFloat(i.lat)) ? parseFloat(i.lat) : null,
            lng: Number.isFinite(parseFloat(i.lng)) ? parseFloat(i.lng) : null,
            scheduledDays: Array.isArray(i.scheduledDays) ? i.scheduledDays : [],
            createdAt: Date.now(),
          });
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
  // === Login gate ===
  document.getElementById('login-google-btn').addEventListener('click', signIn);
  document.getElementById('login-local-btn').addEventListener('click', () => {
    state.offlineMode = true;
    switchView('trips');
    renderTripsList();
    toast('Continuing offline — no sync.', '');
  });

  // Back button — assigned as .onclick further below to allow overriding


  // Theme
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  updateThemeIcon();

  // Auth
  document.getElementById('auth-chip').addEventListener('click', () => {
    if (!state.firebaseReady) {
      switchView('login');
      return;
    }
    if (state.user) {
      if (confirm('Sign out? Your local view of trips will be cleared until you sign in again.')) {
        signOut();
      }
    } else {
      switchView('login');
    }
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
    if (e.key !== 'Escape') return;
    const tripM = document.getElementById('trip-modal');
    const simM = document.getElementById('schedule-idea-modal');
    const previewM = document.getElementById('attach-preview-modal');
    if (!tripM.classList.contains('hidden')) closeTripModal();
    else if (!simM.classList.contains('hidden')) closeScheduleIdeaModal();
    else if (!previewM.classList.contains('hidden')) closeAttachmentPreview();
  });

  // ===== Back button — extended for new views =====
  // (Rewire because we need to know about stays/ideas)
  document.getElementById('back-btn').removeEventListener?.('click', null);
  document.getElementById('back-btn').onclick = () => {
    if (state.currentView === 'activity-form') {
      state.editingActivityId = null;
      state.pendingAttachments = [];
      switchView('trip-detail');
    } else if (state.currentView === 'stay-form') {
      state.editingStayId = null;
      state.pendingAttachments = [];
      switchView('trip-detail');
      switchTab('stays');
    } else if (state.currentView === 'idea-form') {
      state.editingIdeaId = null;
      switchView('trip-detail');
      switchTab('ideas');
    } else if (state.currentView === 'trip-detail') {
      state.currentTripId = null;
      window.MapMod.destroyAllMaps();
      switchView('trips');
    }
  };

  // ===== Tabs (new) =====
  // Handled below by original tab loop, but new tabs auto-work due to data-tab.

  // ===== Stays =====
  document.getElementById('add-stay-btn').addEventListener('click', () => openStayForm(null));
  document.getElementById('stay-form').addEventListener('submit', handleStayFormSubmit);
  document.getElementById('sf-cancel').addEventListener('click', () => {
    state.editingStayId = null;
    state.pendingAttachments = [];
    switchView('trip-detail');
    switchTab('stays');
  });
  window.MapMod.attachGeocodeSearch(
    document.getElementById('sf-address'),
    document.getElementById('sf-address-results'),
    (pick) => {
      state.pickedStayCoord = { lat: pick.lat, lng: pick.lng };
      document.getElementById('sf-address').value = pick.address || pick.name;
    }
  );
  document.getElementById('sf-attach-file').addEventListener('change', (e) => {
    handleAttachmentPick('sf-attach-file', 'sf-attachments-list', e);
  });

  // ===== Ideas =====
  document.getElementById('add-idea-btn').addEventListener('click', () => openIdeaForm(null));
  document.getElementById('idea-form').addEventListener('submit', handleIdeaFormSubmit);
  document.getElementById('if-cancel').addEventListener('click', () => {
    state.editingIdeaId = null;
    switchView('trip-detail');
    switchTab('ideas');
  });
  window.MapMod.attachGeocodeSearch(
    document.getElementById('if-location'),
    document.getElementById('if-location-results'),
    (pick) => {
      state.pickedIdeaCoord = { lat: pick.lat, lng: pick.lng };
      document.getElementById('if-location').value = pick.address || pick.name;
    }
  );

  // ===== Schedule Idea modal =====
  document.getElementById('schedule-idea-form').addEventListener('submit', handleScheduleIdeaSubmit);
  document.getElementById('sim-cancel').addEventListener('click', closeScheduleIdeaModal);
  document.getElementById('schedule-idea-modal').addEventListener('click', (e) => {
    if (e.target.id === 'schedule-idea-modal') closeScheduleIdeaModal();
  });

  // ===== People / invites =====
  document.getElementById('invite-form').addEventListener('submit', handleInviteCollaborator);
  document.getElementById('people-signin-btn').addEventListener('click', signIn);
  document.getElementById('join-code-generate').addEventListener('click', handleGenerateJoinCode);
  document.getElementById('join-code-revoke').addEventListener('click', handleRevokeJoinCode);
  document.getElementById('join-code-copy').addEventListener('click', handleCopyJoinCode);
  document.getElementById('join-code-share').addEventListener('click', handleShareJoinCode);

  // Join by code (trips screen)
  document.getElementById('show-join-btn').addEventListener('click', showJoinPanel);
  document.getElementById('join-cancel').addEventListener('click', hideJoinPanel);
  document.getElementById('join-form').addEventListener('submit', handleJoinByCode);
  document.getElementById('join-code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  // ===== Activity form attachments =====
  document.getElementById('af-attach-file').addEventListener('change', (e) => {
    handleAttachmentPick('af-attach-file', 'af-attachments-list', e);
  });

  // ===== Attachment preview modal =====
  document.getElementById('preview-close').addEventListener('click', closeAttachmentPreview);
  document.getElementById('attach-preview-modal').addEventListener('click', (e) => {
    if (e.target.id === 'attach-preview-modal') closeAttachmentPreview();
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

  // Show login gate by default
  switchView('login');

  // If Firebase is configured, wait for auth. Otherwise let user proceed offline.
  await initFirebase();
  updateAuthUI();

  // If Firebase isn't configured, we still allow local mode via "Continue offline"
  // (default behaviour). Auto-enter trips view since there's no auth to wait for.
  if (!isFirebaseConfigured()) {
    // No sign-in possible — go straight to trips (local-only mode)
    // BUT keep login screen visible until user clicks Continue offline
    // (so they see the warning). If we didn't show config warn, this is a bug.
  }

  registerSW();
  setupInstallPrompt();
}

document.addEventListener('DOMContentLoaded', init);
