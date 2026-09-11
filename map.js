/* =============================================================
 * Map — Leaflet + OpenStreetMap
 * Geocoding via Nominatim (rate-limited — 1 req/sec, be polite)
 * ============================================================= */

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

const mapRegistry = new Map(); // id -> Leaflet map instance

function makePinIcon(number) {
  return L.divIcon({
    className: '',
    html: `<div class="pin-marker"><span>${number}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
  });
}

/**
 * Render a map at a container element. `points` = [{lat, lng, name, time, ...}].
 * Fits bounds to points; draws polyline between them in order.
 */
function renderMap(container, points, opts = {}) {
  if (!container) return null;

  // Destroy old map if any
  const key = container.id || 'anon';
  if (mapRegistry.has(key)) {
    try { mapRegistry.get(key).remove(); } catch (e) {}
    mapRegistry.delete(key);
  }

  const validPts = (points || []).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!validPts.length) return null;

  const map = L.map(container, {
    zoomControl: true,
    scrollWheelZoom: opts.scrollWheelZoom !== false,
    attributionControl: true,
  });

  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);

  // Markers
  validPts.forEach((p, i) => {
    const m = L.marker([p.lat, p.lng], { icon: makePinIcon(i + 1) }).addTo(map);
    const popup = `
      <strong>${escapeHtmlMap(p.name || 'Location')}</strong>
      ${p.time ? `<div style="font-family:monospace;font-size:12px;color:#666">${escapeHtmlMap(p.time)}</div>` : ''}
      ${p.location ? `<div style="font-size:12px;color:#666">${escapeHtmlMap(p.location)}</div>` : ''}
    `;
    m.bindPopup(popup);
  });

  // Polyline
  if (validPts.length > 1 && opts.polyline !== false) {
    const coords = validPts.map(p => [p.lat, p.lng]);
    L.polyline(coords, {
      color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2b6dfb',
      weight: 3,
      opacity: 0.75,
      dashArray: '6, 8',
    }).addTo(map);
  }

  // Fit bounds
  const bounds = L.latLngBounds(validPts.map(p => [p.lat, p.lng]));
  map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });

  mapRegistry.set(key, map);
  // Nudge in case container was hidden during init
  setTimeout(() => map.invalidateSize(), 60);
  return map;
}

function invalidateMap(id) {
  const m = mapRegistry.get(id);
  if (m) setTimeout(() => m.invalidateSize(), 60);
}

function destroyAllMaps() {
  mapRegistry.forEach(m => { try { m.remove(); } catch (e) {} });
  mapRegistry.clear();
}

/* ---------- Geocoding (Nominatim) ---------- */
let lastGeocodeTime = 0;
async function geocode(query, limit = 5) {
  if (!query || query.trim().length < 2) return [];

  // Throttle: at least 1s between calls per Nominatim usage policy
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastGeocodeTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocodeTime = Date.now();

  const url = new URL(NOMINATIM + '/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '1');

  try {
    const res = await fetch(url.toString(), {
      headers: { 'Accept-Language': navigator.language || 'en' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map(d => ({
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
      name: d.display_name.split(',')[0],
      address: d.display_name,
      type: d.type,
    }));
  } catch (err) {
    console.warn('Geocode failed:', err);
    return [];
  }
}

/**
 * Attach a typeahead to a text input. On selection, fires onPick({lat, lng, name, address}).
 */
function attachGeocodeSearch(input, resultsEl, onPick) {
  let debounceTimer = null;
  let currentReq = 0;

  const doSearch = async (q) => {
    const reqId = ++currentReq;
    const results = await geocode(q, 6);
    if (reqId !== currentReq) return; // stale
    if (!results.length) {
      resultsEl.classList.add('hidden');
      resultsEl.innerHTML = '';
      return;
    }
    resultsEl.innerHTML = results.map((r, i) => `
      <div class="location-result" data-idx="${i}">
        <div class="lr-name">${escapeHtmlMap(r.name)}</div>
        <div class="lr-addr">${escapeHtmlMap(r.address)}</div>
      </div>
    `).join('');
    resultsEl.classList.remove('hidden');
    resultsEl.querySelectorAll('.location-result').forEach((el, i) => {
      el.addEventListener('click', () => {
        onPick(results[i]);
        resultsEl.classList.add('hidden');
      });
    });
  };

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const v = input.value.trim();
    if (v.length < 2) {
      resultsEl.classList.add('hidden');
      resultsEl.innerHTML = '';
      return;
    }
    debounceTimer = setTimeout(() => doSearch(v), 380);
  });

  input.addEventListener('blur', () => {
    // Delay so click on a result still fires
    setTimeout(() => resultsEl.classList.add('hidden'), 200);
  });
  input.addEventListener('focus', () => {
    if (resultsEl.innerHTML) resultsEl.classList.remove('hidden');
  });
}

function escapeHtmlMap(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

window.MapMod = { renderMap, invalidateMap, destroyAllMaps, geocode, attachGeocodeSearch };
