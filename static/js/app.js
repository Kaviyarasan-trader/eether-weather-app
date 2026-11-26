/* ============================================================
   AETHER WEATHER — application controller
   ============================================================ */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const S = {
    settings: {},
    locations: [],
    searchHistory: [],
    active: null,
    data: null,
    locationEnabled: false,
    refreshTimer: null,
    notified: new Set(),
    assistant: { history: [] },
    radar: {
      map: null, basemap: null, overlay: null, marker: null, circle: null,
      frames: [], host: null, index: 0, layer: 'rain', indexFetchedAt: 0,
      indexPromise: null, indexToken: 0, frameRaf: 0, renderToken: 0,
      overlayUrl: null, lastCenter: null, controlsBound: false
    }
  };

  // Visitor-owned storage. Every browser profile gets its own ID, so one
  // visitor's city choice can never become another visitor's starting city.
  const STORAGE = {
    guestId: 'aether:guest:id',
    selectedCityPrefix: 'aether:guest:selected_city:',
    themePrefix: 'aether:guest:theme:',
    savedLocationsPrefix: 'aether:guest:locations:',
    searchHistoryPrefix: 'aether:guest:search_history:'
  };
  let cachedGuestId = null;
  let locating = false;
  let weatherRequestId = 0;
  let weatherAbort = null;
  let clockTimer = null;
  let activeRefreshMinutes = null;
  let refreshWasEnabled = false;
  let visibilityBound = false;
  let sideLocationsSignature = '';
  let cachedRules = null;
  let searchTimer = null;
  let searchFocusTimer = null;
  let searchAbort = null;
  let searchRequestId = 0;
  const inflightGets = new Map();
  const DEFAULT_CLIENT_SETTINGS = {
    temperature_unit: 'C', distance_unit: 'km', hour_format: '24',
    theme: 'light', language: 'en', refresh_minutes: 10,
    notifications: { rain: true, alerts: true, air: false }
  };

  /* ---------------- helpers ---------------- */
  function csrf() {
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage may be blocked */ }
  }

  function getGuestId() {
    if (cachedGuestId) return cachedGuestId;
    let id = null;
    try { id = localStorage.getItem(STORAGE.guestId); } catch (e) { id = null; }
    if (!id) {
      id = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      try { localStorage.setItem(STORAGE.guestId, id); } catch (e) { /* storage may be blocked */ }
    }
    cachedGuestId = id;
    return id;
  }

  function selectedCityKey() { return STORAGE.selectedCityPrefix + getGuestId(); }
  function themeKey() { return STORAGE.themePrefix + getGuestId(); }
  function savedLocationsKey() { return STORAGE.savedLocationsPrefix + getGuestId(); }
  function searchHistoryKey() { return STORAGE.searchHistoryPrefix + getGuestId(); }

  function readTheme() {
    let saved = null;
    try { saved = localStorage.getItem(themeKey()); } catch (e) { saved = null; }
    return saved === 'dark' ? 'dark' : 'light';
  }

  function writeTheme(theme) {
    try { localStorage.setItem(themeKey(), theme === 'dark' ? 'dark' : 'light'); } catch (e) { /* storage may be blocked */ }
  }

  function validCity(v) {
    if (!v || typeof v !== 'object') return false;
    const hasName = typeof v.name === 'string' && v.name.trim().length > 0;
    const hasCoords = v.lat != null && v.lon != null &&
      isFinite(Number(v.lat)) && isFinite(Number(v.lon));
    return hasName || hasCoords;
  }

  function normalizeCity(loc) {
    if (!loc) return null;
    const out = {};
    if (loc.id != null && loc.id !== '') out.id = Number(loc.id);
    if (loc.name) out.name = String(loc.name);
    if (loc.lat != null && loc.lon != null) {
      out.lat = Number(loc.lat);
      out.lon = Number(loc.lon);
    }
    ['region', 'country', 'country_code'].forEach(k => {
      if (loc[k]) out[k] = String(loc[k]);
    });
    if (loc.source === 'gps') out.source = 'gps';
    return out;
  }

  function writeSelectedCity(loc) {
    const clean = normalizeCity(loc);
    if (clean) writeJSON(selectedCityKey(), clean);
  }

  function setAppLoadingMessage(message) {
    const text = $('#appLoadingText');
    if (text) text.textContent = message;
  }

  function showAppLoading(message) {
    const overlay = $('#appLoading');
    if (!overlay) return;
    setAppLoadingMessage(message || 'Detecting your location...');
    overlay.hidden = false;
    overlay.setAttribute('aria-busy', 'true');
    // Force a style flush so the centred overlay paints before geolocation starts.
    void overlay.offsetWidth;
  }

  function hideAppLoading() {
    const overlay = $('#appLoading');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.setAttribute('aria-busy', 'false');
  }

  function validSavedCity(v) {
    return validCity(v) && typeof v.name === 'string' && v.name.trim().length > 0;
  }

  function sameCity(a, b) {
    if (!a || !b) return false;
    const an = String(a.name || '').trim().toLowerCase();
    const bn = String(b.name || '').trim().toLowerCase();
    const ac = String(a.country || a.country_code || '').trim().toLowerCase();
    const bc = String(b.country || b.country_code || '').trim().toLowerCase();
    const sameName = !!an && an === bn;
    const sameCountry = ac === bc;
    const noCoordinates = (a.lat == null || a.lon == null) && (b.lat == null || b.lon == null);
    if (sameName && sameCountry && (ac || noCoordinates)) return true;
    if (a.lat != null && a.lon != null && b.lat != null && b.lon != null) {
      const lat = Number(a.lat), lon = Number(a.lon);
      const otherLat = Number(b.lat), otherLon = Number(b.lon);
      if (isFinite(lat) && isFinite(lon) && isFinite(otherLat) && isFinite(otherLon) &&
          Math.abs(lat - otherLat) < 0.01 && Math.abs(lon - otherLon) < 0.01) return true;
    }
    return false;
  }

  function nextSavedId(list) {
    const used = new Set((list || []).map(c => Number(c.id)).filter(Number.isFinite));
    let id = Date.now();
    while (used.has(id)) id += 1;
    return id;
  }

  function readSavedLocations() {
    const key = savedLocationsKey();
    let stored;
    try {
      const raw = localStorage.getItem(key);
      stored = raw ? JSON.parse(raw) : [];
    } catch (e) {
      writeJSON(key, []);
      return [];
    }
    if (!Array.isArray(stored)) {
      writeJSON(key, []);
      return [];
    }
    const cleanList = [];
    stored.forEach(item => {
      if (!validSavedCity(item)) return;
      const clean = normalizeCity(item);
      if (!Number.isFinite(clean.id) || cleanList.some(existing => existing.id === clean.id)) {
        clean.id = nextSavedId(cleanList);
      }
      delete clean.source; // saved search results are not GPS selections
      if (cleanList.some(existing => sameCity(existing, clean))) return;
      cleanList.push(clean);
    });
    if (cleanList.length !== stored.length) writeSavedLocations(cleanList);
    return cleanList;
  }

  function writeSavedLocations(list) {
    writeJSON(savedLocationsKey(), (list || []).filter(validSavedCity).map(normalizeCity));
  }

  const SEARCH_HISTORY_LIMIT = 8;

  function nextHistoryId(list) {
    const used = new Set((list || []).map(c => Number(c.id)).filter(Number.isFinite));
    let id = Date.now();
    while (used.has(id)) id += 1;
    return id;
  }

  function writeSearchHistory(list) {
    const clean = (list || []).filter(validSavedCity).map(normalizeCity).slice(0, SEARCH_HISTORY_LIMIT);
    clean.forEach(c => delete c.source);
    writeJSON(searchHistoryKey(), clean);
  }

  function seededSearchHistory() {
    const seeded = [];
    S.locations.slice(0, SEARCH_HISTORY_LIMIT).forEach(city => {
      if (!validSavedCity(city) || seeded.some(existing => sameCity(existing, city))) return;
      const clean = normalizeCity(city);
      clean.id = nextHistoryId(seeded);
      delete clean.source;
      seeded.push(clean);
    });
    return seeded;
  }

  function readSearchHistory() {
    const key = searchHistoryKey();
    let raw = null;
    try { raw = localStorage.getItem(key); } catch (e) { return seededSearchHistory(); }
    if (raw == null) {
      const seeded = seededSearchHistory();
      writeSearchHistory(seeded);
      return seeded;
    }
    let stored;
    try { stored = raw ? JSON.parse(raw) : []; } catch (e) { writeSearchHistory([]); return []; }
    if (!Array.isArray(stored)) { writeSearchHistory([]); return []; }
    const cleanList = [];
    stored.forEach(item => {
      if (!validSavedCity(item)) return;
      const clean = normalizeCity(item);
      if (!Number.isFinite(clean.id) || cleanList.some(existing => existing.id === clean.id)) {
        clean.id = nextHistoryId(cleanList);
      }
      delete clean.source;
      if (cleanList.some(existing => sameCity(existing, clean))) return;
      cleanList.push(clean);
    });
    const limited = cleanList.slice(0, SEARCH_HISTORY_LIMIT);
    if (JSON.stringify(limited) !== JSON.stringify(stored)) writeSearchHistory(limited);
    return limited;
  }

  function loadSearchHistory() {
    S.searchHistory = readSearchHistory();
  }

  function addSearchHistory(city) {
    if (!validSavedCity(city)) return null;
    const existingIndex = S.searchHistory.findIndex(existing => sameCity(existing, city));
    if (existingIndex >= 0) {
      const existing = S.searchHistory[existingIndex];
      const updated = normalizeCity(Object.assign({}, existing, city, { id: existing.id }));
      delete updated.source;
      S.searchHistory.splice(existingIndex, 1);
      S.searchHistory.unshift(updated);
    } else {
      const entry = normalizeCity(city);
      entry.id = nextHistoryId(S.searchHistory);
      delete entry.source;
      S.searchHistory.unshift(entry);
      S.searchHistory = S.searchHistory.slice(0, SEARCH_HISTORY_LIMIT);
    }
    writeSearchHistory(S.searchHistory);
    return S.searchHistory[0];
  }

  function removeSearchHistory(id) {
    const numericId = Number(id);
    const index = S.searchHistory.findIndex(c => Number(c.id) === numericId);
    if (index < 0) return null;
    const removed = S.searchHistory.splice(index, 1)[0];
    writeSearchHistory(S.searchHistory);
    return removed;
  }

  function findSavedCity(city) {
    return S.locations.find(existing => sameCity(existing, city)) || null;
  }

  function addSavedCity(result) {
    if (!validSavedCity(result)) return { existing: false, location: null };
    const existing = findSavedCity(result);
    if (existing) return { existing: true, location: existing };
    const location = normalizeCity({
      id: nextSavedId(S.locations),
      name: result.name,
      lat: result.lat,
      lon: result.lon,
      region: result.state || result.region,
      country: result.country,
      country_code: result.country_code
    });
    S.locations.push(location);
    writeSavedLocations(S.locations);
    return { existing: false, location: location };
  }

  function removeSavedCity(id) {
    const numericId = Number(id);
    const index = S.locations.findIndex(c => c.id === numericId);
    if (index < 0) return null;
    const removed = S.locations[index];
    S.locations.splice(index, 1);
    writeSavedLocations(S.locations);
    // The dashboard city is intentional: it stays until the visitor picks another.
    return removed;
  }

  function requestRemoveSavedCity(id) {
    const numericId = Number(id);
    const city = S.locations.find(c => c.id === numericId);
    if (!city) { toast('Saved city not found.', 'error'); return; }
    if (!window.confirm('Remove ' + city.name + ' from saved locations?')) return;
    removeSavedCity(numericId);
    toast(city.name + ' removed');
    renderSideLocations();
    if (CFG.page === 'home') renderPage();
  }

  async function api(url, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    opts.headers = opts.headers || {};
    opts.headers['X-Requested-With'] = 'XMLHttpRequest';
    if (opts.method && opts.method.toUpperCase() !== 'GET') opts.headers['X-CSRFToken'] = csrf();
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    // Plain GETs are deduplicated. Calls with an explicit AbortController
    // (weather/search) intentionally bypass this so stale requests can be
    // cancelled without poisoning a newer request for the same URL.
    const isGet = !opts.method || opts.method.toUpperCase() === 'GET';
    const key = isGet && !opts.signal ? url : null;
    if (key && inflightGets.has(key)) return inflightGets.get(key);
    const task = (async () => {
      const res = await fetch(url, opts);
      let payload;
      try { payload = await res.json(); } catch (e) { payload = { ok: false, error: 'Invalid server response.' }; }
      if (!res.ok && !payload.error) payload.error = 'Request failed (' + res.status + ')';
      return payload;
    })();
    if (!key) return task;
    inflightGets.set(key, task);
    try { return await task; }
    finally { if (inflightGets.get(key) === task) inflightGets.delete(key); }
  }

  function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || err.code === 20);
  }

  function toast(message, type) {
    const stack = $('#toastStack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'success');
    el.innerHTML = '<i class="fa-solid ' + (type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check') + '"></i><span>' + esc(message) + '</span>';
    stack.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3800);
  }

  function locationButtonLabel() {
    return S.locationEnabled ? 'Current Location' : 'Enable Location';
  }

  function updateLocationButtons() {
    [$('#currentLocationBtn'), $('#geoBtn'), $('#locateBtn')].forEach(btn => {
      if (!btn) return;
      btn.disabled = false;
      btn.title = S.locationEnabled ? 'Use current location' : 'Enable location';
      btn.setAttribute('aria-label', btn.title);
      btn.innerHTML = '<i class="fa-solid fa-crosshairs"></i><span>' + locationButtonLabel() + '</span>';
    });
  }

  function setLocating(active, label) {
    [$('#currentLocationBtn'), $('#geoBtn'), $('#locateBtn'), $('#gateLocationBtn')].forEach(btn => {
      if (!btn) return;
      btn.disabled = !!active;
      btn.innerHTML = active
        ? '<i class="fa-solid fa-spinner fa-spin"></i><span>Locating…</span>'
        : '<i class="fa-solid fa-crosshairs"></i><span>' + locationButtonLabel() + '</span>';
    });
    if (active && label) {
      const city = $('#topCity'), meta = $('#topMeta');
      if (city) city.textContent = label;
      if (meta) meta.textContent = 'Requesting browser permission…';
    } else if (!active) {
      updateTopbar();
    }
  }

  function tempVal(v) {
    if (v == null || !isFinite(v)) return null;
    return S.settings.temperature_unit === 'F' ? v * 9 / 5 + 32 : v;
  }
  function temp(v) {
    const n = tempVal(v);
    return n == null ? '—' : Math.round(n) + '°' + (S.settings.temperature_unit || 'C');
  }
  function temp1(v) {
    const n = tempVal(v);
    return n == null ? '—' : n.toFixed(1) + '°' + (S.settings.temperature_unit || 'C');
  }
  function speed(v) {
    if (v == null) return '—';
    const mi = S.settings.distance_unit === 'mi';
    return (mi ? v * 2.23694 : v).toFixed(1) + ' ' + (mi ? 'mph' : 'm/s');
  }
  function distance(m) {
    if (m == null) return '—';
    const mi = S.settings.distance_unit === 'mi';
    return (mi ? m / 1609.34 : m / 1000).toFixed(1) + ' ' + (mi ? 'mi' : 'km');
  }
  function localDate(epoch) {
    const off = (S.data && S.data.location && S.data.location.timezone_offset) || 0;
    return new Date(((epoch == null ? Date.now() / 1000 : epoch) + off) * 1000);
  }
  function clock(d, withSeconds) {
    const h12 = S.settings.hour_format === '12';
    let h = d.getUTCHours();
    const suffix = h12 ? (h >= 12 ? ' PM' : ' AM') : '';
    if (h12) h = h % 12 || 12;
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return String(h).padStart(h12 ? 1 : 2, '0') + ':' + mm + (withSeconds ? ':' + String(d.getUTCSeconds()).padStart(2, '0') : '') + suffix;
  }
  function prettyDate(d) {
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  function isNightAt(epoch) {
    const h = localDate(epoch).getUTCHours();
    return h < 6 || h >= 19;
  }
  function conditionKey(id, night) {
    id = Number(id || 0);
    if (id >= 200 && id < 300) return 'thunder';
    if (id >= 300 && id < 500) return 'drizzle';
    if (id >= 500 && id < 600) return 'rain';
    if (id >= 600 && id < 700) return 'snow';
    if (id >= 700 && id < 800) return 'fog';
    if (id === 800) return night ? 'clear-night' : 'clear';
    if (id === 801 || id === 802) return night ? 'partly-night' : 'partly';
    return 'cloudy';
  }

  /* ---------------- weather illustrations ---------------- */
  function sunSvg(size, color) {
    const c = color || '#f3cf8d';
    let rays = '';
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      const x1 = 50 + 25 * Math.cos(a), y1 = 50 + 25 * Math.sin(a);
      const x2 = 50 + 33 * Math.cos(a), y2 = 50 + 33 * Math.sin(a);
      rays += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"/>';
    }
    return '<g class="sun-rays" stroke="' + c + '" stroke-width="3" stroke-linecap="round">' + rays + '</g><circle cx="50" cy="50" r="17" fill="' + c + '"/>';
  }
  function moonSvg(size) {
    return '<path d="M 64 18 A 33 33 0 1 0 64 82 A 26 26 0 1 1 64 18 Z" fill="#dfe9ff"/>' +
      '<circle cx="34" cy="38" r="3" fill="#b9c9e8" opacity=".5"/><circle cx="40" cy="62" r="2" fill="#b9c9e8" opacity=".4"/>';
  }
  function cloudSvg(fill) {
    return '<path class="cloud-float" d="M 24 70 a 17 17 0 0 1 4 -33 a 23 23 0 0 1 43 5 a 15 15 0 0 1 3 28 Z" fill="' + (fill || '#c8d6ef') + '"/>';
  }
  function icon(code, night, size) {
    size = size || 44;
    const key = conditionKey(code, night);
    let inner = '';
    if (key === 'clear') inner = sunSvg(size);
    else if (key === 'clear-night') inner = moonSvg(size);
    else if (key === 'partly') inner = '<g transform="translate(-8,-10) scale(.72)">' + sunSvg(size) + '</g>' + cloudSvg('#d5e0f5');
    else if (key === 'partly-night') inner = '<g transform="translate(-8,-10) scale(.62)">' + moonSvg(size) + '</g>' + cloudSvg('#c2d0ea');
    else if (key === 'cloudy') inner = '<g transform="translate(-2,-1)">' + cloudSvg('#aebfdc') + '</g><path class="cloud-float" d="M 40 72 a 13 13 0 0 1 3 -25 a 18 18 0 0 1 33 4 a 12 12 0 0 1 2 21 Z" fill="#d3def2" opacity=".75"/>';
    else if (key === 'fog') inner = cloudSvg('#b9c8e2') + '<g stroke="#c3d1e8" stroke-width="3" stroke-linecap="round" opacity=".8"><line x1="24" y1="80" x2="62" y2="80"/><line x1="34" y1="89" x2="76" y2="89"/></g>';
    else if (key === 'rain' || key === 'drizzle') {
      inner = cloudSvg('#9fb3d4') + '<g stroke="#78a9ff" stroke-width="3.5" stroke-linecap="round" fill="none"><line class="rain-drop" x1="36" y1="78" x2="31" y2="92"/><line class="rain-drop" x1="52" y1="78" x2="47" y2="92"/><line class="rain-drop" x1="68" y1="78" x2="63" y2="92"/></g>';
    } else if (key === 'snow') {
      inner = cloudSvg('#bccbe4') + '<g fill="#e8f1ff"><circle class="snow-flake" cx="35" cy="84" r="3"/><circle class="snow-flake" cx="52" cy="88" r="3"/><circle class="snow-flake" cx="69" cy="84" r="3"/></g>';
    } else if (key === 'thunder') {
      inner = cloudSvg('#899bbd') + '<path class="bolt" d="M 55 74 L 42 96 L 54 96 L 47 112 L 70 88 L 57 88 L 65 74 Z" fill="#f6d27a"/>';
    }
    return '<svg class="wicon" width="' + size + '" height="' + size + '" viewBox="0 0 100 118" aria-hidden="true">' + inner + '</svg>';
  }

  function setAtmosphere(condition) {
    document.body.setAttribute('data-condition', condition || 'clear');
    if (condition === 'thunder') {
      const el = $('#lightning');
      if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    }
  }

  /* ---------------- shared shell ---------------- */
  function applyTheme(theme) {
    const mode = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', mode);
    const btn = $('#themeBtn');
    if (btn) {
      // Show the mode the button switches to: Moon in light mode, Sun in dark mode.
      const nextMode = mode === 'light' ? 'dark' : 'light';
      const icon = mode === 'light' ? 'moon' : 'sun';
      btn.innerHTML = '<i class="fa-solid fa-' + icon + '" aria-hidden="true"></i>';
      const label = 'Switch to ' + nextMode + ' mode';
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'light' ? '#eaf1fb' : '#070c17');
    $$('[data-setting="theme"] button').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-value') === mode);
    });
  }

  const I18N = {
    en: { home: 'Home', forecast: 'Forecast', radar: 'Radar', air: 'Air Quality', settings: 'Settings', insights: 'Assistant', astronomy: 'Astronomy', alerts: 'Alerts', uv: 'UV & Sun', search: 'Search city', refresh: 'Refresh data', overview: 'LIVE CONDITIONS' },
    es: { home: 'Inicio', forecast: 'Pronóstico', radar: 'Radar', air: 'Calidad del aire', settings: 'Ajustes', insights: 'Asistente', astronomy: 'Astronomía', alerts: 'Alertas', uv: 'UV y Sol', search: 'Buscar ciudad', refresh: 'Actualizar', overview: 'CONDICIONES EN VIVO' },
    fr: { home: 'Accueil', forecast: 'Prévisions', radar: 'Radar', air: 'Qualité de l’air', settings: 'Paramètres', insights: 'Assistant', astronomy: 'Astronomie', alerts: 'Alertes', uv: 'UV & Soleil', search: 'Rechercher', refresh: 'Actualiser', overview: 'CONDITIONS EN DIRECT' },
    de: { home: 'Start', forecast: 'Vorhersage', radar: 'Radar', air: 'Luftqualität', settings: 'Einstellungen', insights: 'Assistent', astronomy: 'Astronomie', alerts: 'Warnungen', uv: 'UV & Sonne', search: 'Stadt suchen', refresh: 'Aktualisieren', overview: 'LIVE-BEDINGUNGEN' }
  };
  function applyLanguage(lang) {
    const dict = I18N[lang] || I18N.en;
    $$('[data-nav]').forEach(a => { const k = a.getAttribute('data-nav'); if (dict[k]) a.childNodes[a.childNodes.length - 1].textContent = ' ' + dict[k]; });
    const eyebrow = $('.page-eyebrow');
    if (eyebrow && dict.overview) eyebrow.textContent = dict.overview;
    const sb = $('#searchBtn'), rb = $('#refreshBtn');
    if (sb) sb.title = dict.search;
    if (rb) rb.title = dict.refresh;
  }

  function renderSideLocations(force) {
    const box = $('#sideLocations');
    if (!box) return;
    const signature = JSON.stringify({
      locations: S.locations,
      activeId: S.active ? S.active.id || S.active.name || '' : ''
    });
    if (!force && signature === sideLocationsSignature) return;
    sideLocationsSignature = signature;
    if (!S.locations.length) { box.innerHTML = '<div class="side-city">No saved cities yet</div>'; return; }
    box.innerHTML = S.locations.map(c =>
      '<div class="side-city ' + (S.active && S.active.id === c.id ? 'active' : '') + '" data-city-id="' + c.id + '">' +
      '<span class="side-city-name"><i class="fa-solid fa-location-dot" style="margin-right:7px;opacity:.6"></i>' + esc(c.name) + '</span>' +
      '<span class="side-city-country">' + esc(c.country || '') + '</span>' +
      '<button class="side-city-remove" type="button" data-remove-city="' + c.id + '" title="Remove ' + esc(c.name) + '" aria-label="Remove ' + esc(c.name) + '"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>').join('');
    $$('[data-remove-city]', box).forEach(el => el.addEventListener('click', e => {
      e.stopPropagation();
      requestRemoveSavedCity(el.getAttribute('data-remove-city'));
    }));
    $$('[data-city-id]', box).forEach(el => el.addEventListener('click', e => {
      if (e.target.closest('[data-remove-city]')) return;
      const c = S.locations.find(x => x.id === Number(el.getAttribute('data-city-id')));
      if (c) selectLocation({ id: c.id, name: c.name, lat: c.lat, lon: c.lon });
    }));
  }

  function updateTopbar() {
    const d = S.data;
    const activeName = S.active && S.active.name ? S.active.name : '';
    const name = d ? d.location.name : (activeName || 'Location not enabled');
    const region = [S.active && S.active.region, S.active && S.active.country].filter(Boolean).join(', ');
    const place = region || (d ? d.location.country : '') || 'Current conditions';
    const tag = S.active && S.active.source === 'gps' ? 'GPS · ' : '';
    $('#topCity').textContent = name;
    $('#topMeta').textContent = d
      ? tag + place + ' · ' + prettyDate(localDate(d.current.dt))
      : (activeName ? 'Weather hidden until you enable location or choose a city' : 'Click Enable Location to begin');
  }

  function tickClock() {
    const el = $('#clockChip');
    if (el && S.data) el.textContent = clock(localDate(null), false) + ' local';
    $$('[data-js-clock]').forEach(n => { n.textContent = clock(localDate(null), false); });
  }

  function startClock() {
    tickClock();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(() => { if (!document.hidden) tickClock(); }, 30000);
    bindVisibility();
  }

  function bindVisibility() {
    if (visibilityBound) return;
    visibilityBound = true;
    const apply = () => {
      document.body.classList.toggle('app-hidden', !!document.hidden);
      if (document.hidden) return;
      tickClock();
      if (CFG.page === 'radar' && S.radar.map && $('#mapSlot')) {
        requestAnimationFrame(() => {
          try { S.radar.map.invalidateSize(); } catch (e) { /* map detached */ }
          scheduleRadarFrame();
        });
      }
    };
    document.addEventListener('visibilitychange', apply);
    apply();
  }

  /* ---------------- data loading ---------------- */
  function targetParams() {
    if (S.active && S.active.lat != null && S.active.lon != null) return '?lat=' + S.active.lat + '&lon=' + S.active.lon;
    if (S.active && S.active.name) return '?city=' + encodeURIComponent(S.active.name);
    return '';
  }

  async function loadData(showLoading) {
    const requestId = ++weatherRequestId;
    if (weatherAbort) { weatherAbort.abort(); weatherAbort = null; }
    const root = $('#pageRoot');
    if (!S.locationEnabled) {
      renderLocationGate('Weather data is hidden until you enable location or choose a city.');
      return;
    }
    if (!S.active) {
      renderLocationGate('Choose Enable Location to detect your city, or search for a city manually.');
      return;
    }
    if (showLoading && root) root.innerHTML = skeleton();
    const url = CFG.urls.weather + targetParams() + '&hour_format=' + (S.settings.hour_format || '24');
    const controller = new AbortController();
    weatherAbort = controller;
    try {
      const res = await api(url, { signal: controller.signal });
      if (requestId !== weatherRequestId) return;
      if (!res.ok) throw new Error(res.error || 'Weather data is unavailable.');
      S.data = res;
      setAtmosphere(conditionKey(res.current.weather.id, isNightAt(res.current.dt)));
      updateTopbar();
      renderSideLocations();
      renderPage();
      tickClock();
      evaluateNotifications();
      if (S.active) {
        const refreshed = Object.assign({}, S.active);
        if (res.location.name) refreshed.name = res.location.name;
        if (res.location.lat != null) refreshed.lat = res.location.lat;
        if (res.location.lon != null) refreshed.lon = res.location.lon;
        if (res.location.state || res.location.region) refreshed.region = res.location.state || res.location.region;
        if (res.location.country) refreshed.country = res.location.country;
        if (res.location.country_code) refreshed.country_code = res.location.country_code;
        writeSelectedCity(refreshed);
      }
    } catch (err) {
      if (requestId !== weatherRequestId || isAbortError(err)) return;
      const a = $('#globalAlert');
      if (a) a.innerHTML = '<div class="alert-banner"><i class="fa-solid fa-triangle-exclamation"></i><div><div class="t">Unable to load weather data</div><div class="d">' + esc(err.message) + '</div></div></div>';
      if (root) root.innerHTML = '<div class="empty"><i class="fa-solid fa-cloud-slash"></i><h3>Weather data unavailable</h3><p>' + esc(err.message) + '</p><button class="btn" onclick="location.reload()">Try again</button></div>';
    } finally {
      if (requestId === weatherRequestId && weatherAbort === controller) weatherAbort = null;
    }
  }

  async function loadSettings() {
    const res = await api(CFG.urls.settings);
    S.settings = Object.assign({}, DEFAULT_CLIENT_SETTINGS, res.settings || {}, { theme: readTheme() });
    S.settings.notifications = Object.assign({}, DEFAULT_CLIENT_SETTINGS.notifications, S.settings.notifications || {});
    applyTheme(S.settings.theme);
    applyLanguage(S.settings.language);
    scheduleRefresh();
    // The shell is already usable while settings load; refresh only the page
    // whose controls depend on the stored values.
    if (CFG.page === 'settings') renderSettings();
  }
  function loadLocations() {
    // Guest saved cities belong to this browser, never to the shared City table.
    S.locations = readSavedLocations();
  }
  function saveSettings(patch) {
    const sharedPatch = {};
    Object.keys(patch).forEach(key => {
      if (key === 'theme') writeTheme(patch[key]);
      else sharedPatch[key] = patch[key];
    });

    S.settings = Object.assign({}, S.settings, patch);
    applyTheme(S.settings.theme);
    applyLanguage(S.settings.language);
    scheduleRefresh();

    // Only display/unit preferences are shared; theme stays in this browser.
    if (Object.keys(sharedPatch).length) {
      api(CFG.urls.settings, { method: 'POST', body: sharedPatch }).then(r => {
        if (!r.ok) toast(r.error || 'Could not save settings', 'error');
      });
    }
  }
  function scheduleRefresh() {
    const mins = Number(S.settings.refresh_minutes || 10);
    const enabled = mins > 0 && S.locationEnabled;
    if (mins === activeRefreshMinutes && enabled === refreshWasEnabled) return;
    if (S.refreshTimer) clearInterval(S.refreshTimer);
    S.refreshTimer = null;
    activeRefreshMinutes = mins;
    refreshWasEnabled = enabled;
    if (enabled) {
      S.refreshTimer = setInterval(() => {
        if (!document.hidden && S.data) loadData(false);
      }, mins * 60000);
    }
  }

  function selectLocation(loc) {
    if (!loc) return;
    const next = normalizeCity(loc);
    if (!next) return;
    const changed = !S.active || !sameCity(S.active, next) ||
      (!!next.source && next.source !== S.active.source);
    if (!changed) {
      // Explicitly choosing the active city should not fire another weather
      // request or rebuild the page.
      S.active = next;
      writeSelectedCity(next);
      addSearchHistory(next);
      closeModal();
      return;
    }
    S.assistant.history = [];
    S.active = next;
    S.locationEnabled = true;  // an explicit city choice also unlocks weather
    writeSelectedCity(S.active);
    addSearchHistory(S.active);
    updateLocationButtons();
    const alert = $('#globalAlert');
    if (alert) alert.innerHTML = '';
    scheduleRefresh();
    closeModal();
    loadData(true);
  }

  function skeleton() {
    return '<div class="hero-grid"><div class="card sk-card"></div><div class="card sk-card"></div></div>' +
      '<div class="quick-grid"><div class="card sk-card"></div><div class="card sk-card"></div><div class="card sk-card"></div></div>' +
      '<div class="card skeleton" style="height:260px"></div>';
  }

  /* ---------------- location gate ---------------- */
  function renderLocationGate(message) {
    const root = $('#pageRoot');
    if (!root) return;
    root.innerHTML =
      '<div class="location-gate card"><div class="location-gate-icon"><i class="fa-solid fa-location-crosshairs"></i></div>' +
      '<div class="location-gate-title">No location selected</div>' +
      '<p class="location-gate-text">' + esc(message || 'Choose Enable Location to detect your current city, or search for a city manually. No weather data is shown until then.') + '</p>' +
      '<div class="location-gate-actions">' +
        '<button class="btn btn-primary" id="gateLocationBtn"><i class="fa-solid fa-crosshairs"></i> Enable Location</button>' +
        '<button class="btn" id="gateSearchBtn"><i class="fa-solid fa-magnifying-glass"></i> Search a city</button>' +
      '</div>' +
      '<p class="location-gate-note">No IP address is used, and no location is detected automatically.</p></div>';
    $('#gateLocationBtn').addEventListener('click', enableLocation);
    $('#gateSearchBtn').addEventListener('click', openModal);
    updateTopbar();
  }

  function showLocationError(kind, detail) {
    const box = $('#globalAlert');
    const copy = {
      denied: {
        title: 'Location permission is blocked',
        text: 'Open your browser’s site settings for this page, find Location, change it from Blocked to Allow, then reload and click Enable Location. Chrome/Edge: click the lock icon in the address bar. Firefox: click the shield or lock icon, then Connection secure → More information → Permissions. You can also search for a city manually.'
      },
      unavailable: {
        title: 'Location unavailable',
        text: 'Your browser could not determine a position. Check that device location services are switched on, then try again. You can also use the search button to choose a city manually.'
      },
      error: {
        title: 'Could not read your location',
        text: 'The browser did not return usable coordinates. Try again, or use the search button to choose a city manually.'
      }
    };
    const info = copy[kind] || copy.error;
    if (box) {
      box.innerHTML = '<div class="alert-banner"><i class="fa-solid fa-triangle-exclamation"></i><div>' +
        '<div class="t">' + esc(info.title) + '</div><div class="d">' + esc(info.text) +
        (detail ? ' ' + esc('(' + detail + ')') : '') + '</div></div></div>';
    }
    renderLocationGate(info.text);
  }

  /* ---------------- page dispatcher ---------------- */
  function renderPage() {
    if (!S.data) {
      if (CFG.page === 'settings') renderSettings();
      else renderLocationGate();
      return;
    }
    const map = {
      home: renderHome, forecast: renderForecast, radar: renderRadar, air: renderAir,
      settings: renderSettings, insights: renderInsights, astronomy: renderAstronomy,
      alerts: renderAlerts, uv: renderUV
    };
    (map[CFG.page] || renderHome)(S.data);
  }

  /* ---------------- HOME ---------------- */
  function renderHome(d) {
    const root = $('#pageRoot'); if (!root) return;
    const c = d.current, loc = d.location, now = localDate(c.dt);
    const night = isNightAt(c.dt);
    const key = conditionKey(c.weather.id, night);
    const sunrise = c.sunrise, sunset = c.sunset;
    const progress = sunrise && sunset ? Math.max(0, Math.min(1, (Date.now() / 1000 - sunrise) / (sunset - sunrise))) : 0;
    const pop = Math.max(0, ...d.hourly.map(h => h.pop == null ? 0 : h.pop));
    const air = d.air, uv = d.uv;
    const alerts = d.alerts;
    const insights = window.InsightEngine ? InsightEngine.build(d) : [];

    const alertHtml = alerts.supported && alerts.items.length
      ? '<div class="alert-banner"><i class="fa-solid fa-triangle-exclamation"></i><div><div class="t">' + esc(alerts.items[0].event) + '</div><div class="d">' + esc((alerts.items[0].description || '').slice(0, 180)) + ' — <a class="text-link" href="/alerts/">View alerts</a></div></div></div>'
      : '';

    const hours = d.hourly.slice(0, 8).map(h =>
      '<div class="hour-tile ' + (h.is_now ? 'now' : '') + '">' +
      '<div class="hour-label">' + esc(h.label) + '</div>' +
      icon(h.weather.id, night, 42) +
      '<div class="hour-temp">' + temp(h.temp) + '</div>' +
      (h.pop != null ? '<div class="hour-pop"><i class="fa-solid fa-droplet"></i>' + h.pop + '%</div>' : '') +
      (h.wind_speed != null ? '<div class="hour-wind">' + speed(h.wind_speed) + '</div>' : '') +
      '</div>').join('');

    const metricDefs = [
      ['feels-like', 'fa-temperature-half', 'Feels like', temp(c.feels_like), 'Apparent temperature'],
      ['humidity', 'fa-droplet', 'Humidity', c.humidity + '%', 'Relative humidity'],
      ['wind', 'fa-wind', 'Wind', speed(c.wind_speed), (c.wind_dir || '—') + ' direction'],
      ['gust', 'fa-tornado', 'Wind gusts', c.wind_gust != null ? speed(c.wind_gust) : 'Unavailable', c.wind_gust_source || 'Not in current feed'],
      ['pressure', 'fa-gauge-high', 'Pressure', c.pressure + ' hPa', 'At sea level'],
      ['visibility', 'fa-eye', 'Visibility', distance(c.visibility), 'Horizontal visibility'],
      ['dew', 'fa-cloud-dew', 'Dew point', temp(c.dew_point), 'Calculated value'],
      ['uv', 'fa-sun', 'UV index', uv ? uv.value + ' · ' + uv.level : 'Unavailable', uv ? 'Current observation' : 'Not provided'],
      ['clouds', 'fa-cloud', 'Cloud cover', c.clouds + '%', 'Sky coverage'],
      ['precip', 'fa-umbrella', 'Precipitation', c.precipitation_today + ' mm', 'Today, from 3h totals'],
      ['sunrise', 'fa-arrow-up-right', 'Sunrise', c.sunrise ? clock(localDate(c.sunrise)) : '—', 'Local time']
    ];
    const metrics = metricDefs.map(m =>
      '<div class="card metric-card card-lift"><div class="metric-head"><i class="fa-solid ' + m[1] + '"></i><span class="source-dot"></span></div>' +
      '<div class="metric-label">' + m[2] + '</div><div class="metric-value">' + m[3] + '</div><div class="metric-foot">' + m[4] + '</div></div>').join('');

    const locCards = S.locations.map(l =>
      '<div class="card loc-card ' + (S.active && S.active.id === l.id ? 'active' : '') + '" data-loc-id="' + l.id + '">' +
      '<div class="loc-card-top"><div><div class="loc-card-name">' + esc(l.name) + '</div><div class="loc-card-country">' + esc(l.country || 'Saved') + '</div></div></div>' +
      '<div class="loc-card-body"><div><div class="loc-card-temp">—</div><div class="loc-card-desc">Tap to view</div></div>' + icon(800, false, 40) + '</div>' +
      '<button class="loc-remove" type="button" data-remove-id="' + l.id + '" title="Remove ' + esc(l.name) + '" aria-label="Remove ' + esc(l.name) + '"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>').join('');

    root.innerHTML =
      alertHtml +
      '<div class="hero-grid">' +
        '<div class="card hero-card">' +
          '<div class="hero-top"><div><div class="hero-place"><strong>' + esc(loc.name) + '</strong>' + (loc.country ? ' · ' + esc(loc.country) : '') + '</div>' +
          '<div class="hero-date">' + prettyDate(now) + ' · <span data-js-clock>' + clock(now) + '</span> local time</div></div>' +
          '<div class="hero-badge"><i class="fa-solid fa-satellite-dish"></i> LIVE</div></div>' +
          '<div class="hero-main"><div><div class="temp-display">' + (tempVal(c.temp) == null ? '—' : Math.round(tempVal(c.temp)) + '<sup>°' + (S.settings.temperature_unit || 'C') + '</sup>') + '</div>' +
          '<div class="hero-condition">' + esc(c.weather.description || 'Unknown conditions') + '</div>' +
          '<div class="hero-feels">Feels like ' + temp(c.feels_like) + ' · High ' + temp(c.temp_max) + ' / Low ' + temp(c.temp_min) + '</div></div>' +
          icon(c.weather.id, night, 168) + '</div>' +
          '<div class="hero-bottom">' +
            '<div class="metric-inline"><i class="fa-solid fa-arrow-up"></i><div><div class="m-label">High / Low</div><div class="m-value">' + temp(c.temp_max) + ' · ' + temp(c.temp_min) + '</div></div></div>' +
            '<div class="metric-inline"><i class="fa-solid fa-wind"></i><div><div class="m-label">Wind</div><div class="m-value">' + speed(c.wind_speed) + '</div></div></div>' +
            '<div class="metric-inline"><i class="fa-solid fa-droplet"></i><div><div class="m-label">Rain chance</div><div class="m-value">' + (pop ? pop + '%' : '—') + '</div></div></div>' +
          '</div>' +
        '</div>' +
        '<div class="side-stack">' +
          '<div class="card summary-card"><div class="card-kicker"><i class="fa-solid fa-wand-magic-sparkles"></i> Weather brief</div>' +
          '<div class="summary-text">' + (insights.length ? esc(insights.slice(0, 2).map(i => i.text).join(' ')) : esc(c.weather.description)) + '</div>' +
          '<div class="summary-chips">' + (insights.slice(0, 3).map(i => '<span class="chip ' + i.tone + '"><i class="fa-solid fa-' + i.icon + '"></i>' + esc(i.title) + '</span>').join('')) + '</div>' +
          '<a class="text-link" href="/insights/" style="margin-top:16px">Open weather assistant <i class="fa-solid fa-arrow-right"></i></a></div>' +
          '<div class="card card-pad"><div class="mini-stat"><span class="label"><i class="fa-solid fa-sunrise"></i> Sunrise</span><span class="value">' + (sunrise ? clock(localDate(sunrise)) : '—') + '</span></div>' +
          '<div class="sun-track"><span class="sun-dot" style="left:' + (progress * 100).toFixed(1) + '%"></span></div>' +
          '<div class="mini-stat"><span class="label"><i class="fa-solid fa-sunset"></i> Sunset</span><span class="value">' + (sunset ? clock(localDate(sunset)) : '—') + '</span></div>' +
          '<div class="mini-stat"><span class="label"><i class="fa-solid fa-hourglass-half"></i> Daylight</span><span class="value">' + (d.astronomy.daylight_hours || '—') + ' h</span></div></div>' +
        '</div>' +
      '</div>' +

      '<div class="quick-grid">' +
        '<div class="card quick-card card-lift" data-goto="/air-quality/"><div class="quick-head"><span class="label">Air quality</span><i class="fa-solid fa-arrow-up-right"></i></div>' +
          '<div class="quick-value" style="color:' + (air ? air.color : 'var(--text)') + '">' + (air ? air.aqi : '—') + '</div><div class="quick-desc">' + (air ? esc(air.label) + ' · AQI scale 1–5' : 'Not available for this location') + '</div>' +
          '<div class="quick-bar"><span style="--bar-scale:' + (air ? (air.aqi / 5) : 0).toFixed(3) + ';background:' + (air ? air.color : 'transparent') + '"></span></div></div>' +
        '<div class="card quick-card card-lift" data-goto="/uv/"><div class="quick-head"><span class="label">UV index</span><i class="fa-solid fa-arrow-up-right"></i></div>' +
          '<div class="quick-value" style="color:' + (uv ? uv.color : 'var(--text)') + '">' + (uv ? uv.value : '—') + '</div><div class="quick-desc">' + (uv ? esc(uv.level) : 'Not available for this location') + '</div>' +
          '<div class="quick-bar"><span style="--bar-scale:' + (uv ? Math.min(1, uv.value / 11) : 0).toFixed(3) + ';background:' + (uv ? uv.color : 'transparent') + '"></span></div></div>' +
        '<div class="card quick-card card-lift" data-goto="/alerts/"><div class="quick-head"><span class="label">Weather alerts</span><i class="fa-solid fa-arrow-up-right"></i></div>' +
          '<div class="quick-value">' + (alerts.supported ? alerts.items.length : '—') + '</div><div class="quick-desc">' + (alerts.supported ? 'Active alerts from ' + esc(alerts.source) : 'No alert feed for this region') + '</div>' +
          '<div class="quick-bar"><span style="--bar-scale:' + (alerts.supported && alerts.items.length ? 1 : .08).toFixed(3) + ';background:' + (alerts.items.length ? 'var(--red)' : 'var(--muted-2)') + '"></span></div></div>' +
      '</div>' +

      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-clock-rotate-left"></i> Next 24 hours</div>' +
      '<div class="section-note">3-hour intervals covering the next 24 hours</div></div><a class="text-link" href="/forecast/">Full forecast <i class="fa-solid fa-arrow-right"></i></a></div>' +
      '<div class="hourly-scroll">' + hours + '</div>' +
      '<div class="card card-pad" style="margin-top:14px"><div class="section-head"><div class="section-title" style="font-size:13px"><i class="fa-solid fa-chart-line"></i> Temperature trend</div></div>' +
      '<div id="homeTempChart"></div></div></section>' +

      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-gauge-high"></i> Weather details</div>' +
      '<div class="section-note">Values are live observations or clearly labelled calculations</div></div></div><div class="metrics-grid">' + metrics + '</div></section>' +

      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-location-dot"></i> Your locations</div>' +
      '<div class="section-note">Compare conditions across saved cities</div></div><button class="btn btn-sm" id="addLocBtn"><i class="fa-solid fa-plus"></i> Add city</button></div>' +
      (locCards ? '<div class="location-strip">' + locCards + '</div>' : '<div class="empty"><i class="fa-solid fa-map-pin"></i><h3>No saved locations</h3><p>Use search to add cities and compare their weather.</p></div>') + '</section>';

    Charts.line($('#homeTempChart'), {
      labels: d.hourly.slice(0, 16).map(h => h.label),
      values: d.hourly.slice(0, 16).map(h => h.temp),
      format: v => String(Math.round(tempVal(v))), suffix: '°' + (S.settings.temperature_unit || 'C'),
      title: 'Hourly temperature trend'
    });

    $$('[data-goto]', root).forEach(el => el.addEventListener('click', () => {
      const href = el.getAttribute('data-goto');
      navigateTo(href, pageFromHref(href), true);
    }));
    $$('[data-loc-id]', root).forEach(el => el.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove-id]')) return;
      const l = S.locations.find(x => x.id === Number(el.getAttribute('data-loc-id')));
      if (l) selectLocation({ id: l.id, name: l.name, lat: l.lat, lon: l.lon });
    }));
    $$('[data-remove-id]', root).forEach(el => el.addEventListener('click', (e) => {
      e.stopPropagation();
      requestRemoveSavedCity(el.getAttribute('data-remove-id'));
    }));
    const add = $('#addLocBtn'); if (add) add.addEventListener('click', openModal);
  }

  /* ---------------- FORECAST ---------------- */
  function renderForecast(d) {
    const root = $('#pageRoot'); if (!root) return;
    const days = d.daily;
    const allTemps = days.flatMap(x => [tempVal(x.temp_min), tempVal(x.temp_max)]).filter(v => v != null);
    const min = Math.min(...allTemps), max = Math.max(...allTemps), range = max - min || 1;
    const cards = days.map((day, i) => {
      const lo = tempVal(day.temp_min), hi = tempVal(day.temp_max);
      const p1 = ((lo - min) / range) * 100, p2 = ((hi - min) / range) * 100;
      const night = isNightAt(day.dt || d.current.dt);
      return '<div class="card day-card' + (i === 0 ? ' open' : '') + '" data-day="' + i + '">' +
        '<div class="day-summary"><div><div class="day-name">' + (i === 0 ? 'Today' : esc(day.label)) + '</div><div class="day-date">' + esc(day.long_label) + '</div></div>' +
        '<div class="day-weather">' + icon(day.weather.id, night, 36) + '<span class="cap">' + esc(day.weather.description) + '</span></div>' +
        '<div><div class="day-temps"><span class="hi">' + temp(day.temp_max) + '</span><span class="lo">' + temp(day.temp_min) + '</span></div><div class="range-bar"><i style="left:' + p1.toFixed(1) + '%"></i><i style="left:' + p2.toFixed(1) + '%"></i></div></div>' +
        '<div class="day-pop"><i class="fa-solid fa-droplet"></i>' + day.pop + '%</div><div class="day-chevron"><i class="fa-solid fa-chevron-down"></i></div></div>' +
        '<div class="day-detail"><div class="detail-grid">' +
          '<div class="detail-item"><div class="label">Condition</div><div class="value cap">' + esc(day.weather.description) + '</div></div>' +
          '<div class="detail-item"><div class="label">Max / Min</div><div class="value">' + temp(day.temp_max) + ' / ' + temp(day.temp_min) + '</div></div>' +
          '<div class="detail-item"><div class="label">Rain chance</div><div class="value">' + day.pop + '%</div></div>' +
          '<div class="detail-item"><div class="label">Wind</div><div class="value">' + speed(day.wind_speed) + '</div></div>' +
          '<div class="detail-item"><div class="label">Wind gusts</div><div class="value">' + (day.wind_gust != null ? speed(day.wind_gust) : '—') + '</div></div>' +
          '<div class="detail-item"><div class="label">Humidity</div><div class="value">' + day.humidity + '%</div></div>' +
        '</div>' + (day.samples ? '<div class="tiny muted" style="margin-top:14px">Based on ' + day.samples + ' forecast intervals from the 3-hourly feed.</div>' : '') + '</div></div>';
    }).join('');

    const hourlyLabels = d.hourly.map(h => h.label);
    root.innerHTML =
      '<div class="alert-banner info"><i class="fa-solid fa-circle-info"></i><div><div class="t">Forecast depth: ' + d.meta.forecast_days_available + ' calendar dates</div><div class="d">' + esc(d.meta.forecast_limitation) + '</div></div></div>' +
      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-calendar-days"></i> Daily outlook</div><div class="section-note">Tap a day for detailed conditions</div></div></div><div class="forecast-list">' + cards + '</div></section>' +
      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-temperature-range"></i> Temperature comparison</div><div class="section-note">Daily minimum to maximum range</div></div></div>' +
      '<div class="card card-pad"><div id="rangeChart"></div></div></section>' +
      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-cloud-rain"></i> Rain probability &amp; wind</div></div></div>' +
      '<div class="card card-pad"><div class="section-note" style="margin-bottom:10px">Rain probability (%)</div><div id="popChart"></div>' +
      '<div class="section-note" style="margin:22px 0 10px">Wind speed (' + (S.settings.distance_unit === 'mi' ? 'mph' : 'm/s') + ')</div><div id="windChart"></div></div></section>';

    Charts.ranges($('#rangeChart'), { items: days.map(x => ({ label: x.long_label, min: tempVal(x.temp_min), max: tempVal(x.temp_max) })) });
    const hours = d.hourly.slice(0, 16);
    Charts.bars($('#popChart'), { labels: hours.map(h => h.label), values: hours.map(h => h.pop || 0), suffix: '%', color: '#78a9ff', title: 'Rain probability' });
    Charts.bars($('#windChart'), { labels: hours.map(h => h.label), values: hours.map(h => S.settings.distance_unit === 'mi' ? (h.wind_speed || 0) * 2.23694 : (h.wind_speed || 0)), color: '#b69cff', title: 'Wind speed' });

    $$('.day-summary', root).forEach(el => el.addEventListener('click', () => el.parentElement.classList.toggle('open')));
  }

  /* ---------------- RADAR ---------------- */
  const CARTO_MIN_ZOOM = 0;
  const CARTO_MAX_ZOOM = 18;
  const RAINVIEWER_MAX_NATIVE_ZOOM = 7;
  const RADAR_INDEX_TTL = 5 * 60 * 1000;
  const BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  const RADAR_LAYERS = [
    ['rain', 'fa-cloud-rain', 'Precipitation radar', 'RainViewer · real radar', '#60a5fa'],
    ['precipitation_new', 'fa-cloud-showers-heavy', 'Precipitation', 'OpenWeatherMap', '#38bdf8'],
    ['clouds_new', 'fa-cloud', 'Cloud cover', 'OpenWeatherMap', '#cbd5e1'],
    ['wind_new', 'fa-wind', 'Wind', 'OpenWeatherMap', '#a78bfa'],
    ['temp_new', 'fa-temperature-three-quarters', 'Temperature', 'OpenWeatherMap', '#fb923c']
  ];
  let leafletPromise = null;

  function ensureLeaflet() {
    if (typeof L !== 'undefined') return Promise.resolve(true);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(resolve => {
      if (typeof L !== 'undefined') { resolve(true); return; }
      if (!$('#leafletCss')) {
        const link = document.createElement('link');
        link.id = 'leafletCss';
        link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        link.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
        link.crossOrigin = '';
        document.head.appendChild(link);
      }
      let script = $('#leafletScript');
      if (!script) {
        script = document.createElement('script');
        script.id = 'leafletScript';
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
        script.crossOrigin = '';
        document.head.appendChild(script);
      }
      script.addEventListener('load', () => resolve(typeof L !== 'undefined'), { once: true });
      script.addEventListener('error', () => {
        script.remove();
        leafletPromise = null;
        resolve(false);
      }, { once: true });
    });
    return leafletPromise;
  }

  // Move the live map out of the page view before the SPA replaces its HTML.
  // Leaflet keeps all handlers, tiles and layers while it is parked here.
  function parkRadarMap() {
    const mapEl = $('#map');
    const host = $('#radarMapHost');
    if (!mapEl || !host || host.contains(mapEl)) return;
    host.appendChild(mapEl);
  }

  function radarMarkup(d) {
    return '<div class="radar-layout" id="radarShell"><div class="map-shell"><div id="mapSlot"></div>' +
      '<div class="map-overlay"><div class="map-pill" id="mapPill"><strong>' + esc(d.location.name) + '</strong> · ' +
      d.location.lat.toFixed(2) + ', ' + d.location.lon.toFixed(2) + '</div></div></div>' +
      '<div class="card radar-panel"><div><div class="panel-label">Weather layers</div><div class="layer-list" id="layerList">' +
      RADAR_LAYERS.map(l => '<button class="layer-btn' + (l[0] === S.radar.layer ? ' active' : '') + '" data-layer="' + l[0] + '">' +
        '<i class="fa-solid ' + l[1] + '"></i><span>' + l[2] + '<br><span class="tiny muted">' + l[3] + '</span></span>' +
        '<span class="layer-swatch" style="background:' + l[4] + '"></span></button>').join('') +
      '</div></div><div><div class="timeline-box" id="timelineBox"' + (S.radar.layer === 'rain' ? '' : ' style="display:none"') + '>' +
      '<div class="panel-label">Radar timeline</div><div class="timeline-value" id="frameLabel">Loading…</div>' +
      '<input type="range" id="frameSlider" min="0" max="0" value="0" disabled><div class="timeline-labels"><span>Earlier</span><span>Latest</span></div></div>' +
      '<div class="legend"><div class="panel-label">Intensity</div><div class="legend-bar"></div><div class="legend-labels"><span>Light</span><span>Moderate</span><span>Heavy</span></div></div>' +
      '<div class="tiny muted" style="margin-top:16px">Radar frames are real observations from RainViewer. Satellite overlays are live OpenWeatherMap layers. No simulated animations are used.</div></div></div></div>';
  }

  function bindRadarControls(root) {
    const shell = $('#radarShell', root);
    if (!shell || shell.dataset.bound === '1') return;
    shell.dataset.bound = '1';
    S.radar.controlsBound = true;
    $$('[data-layer]', shell).forEach(btn => btn.addEventListener('click', () => setLayer(btn.getAttribute('data-layer'))));
    const slider = $('#frameSlider', shell);
    if (slider) {
      slider.addEventListener('input', () => {
        S.radar.index = Number(slider.value) || 0;
        scheduleRadarFrame();
      });
    }
  }

  function syncRadarControls() {
    const r = S.radar;
    $$('[data-layer]').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-layer') === r.layer));
    const timeline = $('#timelineBox');
    if (timeline) timeline.style.display = r.layer === 'rain' ? '' : 'none';
  }

  async function renderRadar(d) {
    const root = $('#pageRoot'); if (!root) return;
    const token = ++S.radar.renderToken;
    if (!$('#radarShell', root)) {
      parkRadarMap();
      root.innerHTML = radarMarkup(d);
      bindRadarControls(root);
    }
    const pill = $('#mapPill', root);
    if (pill) pill.innerHTML = '<strong>' + esc(d.location.name) + '</strong> · ' + d.location.lat.toFixed(2) + ', ' + d.location.lon.toFixed(2);
    syncRadarControls();

    const ready = await ensureLeaflet();
    if (token !== S.radar.renderToken || !document.contains(root)) return;
    const slot = $('#mapSlot', root);
    if (!slot) return;
    if (!ready || typeof L === 'undefined') {
      slot.innerHTML = '<div class="empty" style="padding-top:220px"><i class="fa-solid fa-map"></i><h3>Map library unavailable</h3><p>The mapping library could not be loaded. Check your connection and refresh.</p></div>';
      return;
    }

    let mapEl = $('#map');
    if (!mapEl) {
      mapEl = document.createElement('div');
      mapEl.id = 'map';
    }
    if (mapEl.parentNode !== slot) slot.appendChild(mapEl);
    const host = $('#radarMapHost');
    if (host) host.hidden = true;

    const r = S.radar;
    const center = [d.location.lat, d.location.lon];
    if (!r.map) {
      r.map = L.map(mapEl, {
        zoomControl: true,
        minZoom: CARTO_MIN_ZOOM,
        maxZoom: CARTO_MAX_ZOOM,
        zoomSnap: 1,
        zoomDelta: 1
      }).setView(center, 7);
      r.basemap = L.tileLayer(cartoBasemapUrl(), {
        className: 'aether-base-tiles',
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        minZoom: CARTO_MIN_ZOOM,
        maxZoom: CARTO_MAX_ZOOM,
        maxNativeZoom: CARTO_MAX_ZOOM,
        errorTileUrl: BLANK_TILE,
        subdomains: 'abcd'
      }).addTo(r.map);
      r.marker = L.marker(center).addTo(r.map)
        .bindPopup('<strong>' + esc(d.location.name) + '</strong><br>Current location')
        .openPopup();
      r.circle = L.circle(center, { radius: 25000, color: '#e9c07d', weight: 1, fillOpacity: .04 }).addTo(r.map);
      r.overlay = L.tileLayer(BLANK_TILE, {
        attribution: 'RainViewer / OpenWeatherMap',
        minZoom: CARTO_MIN_ZOOM,
        maxZoom: CARTO_MAX_ZOOM,
        maxNativeZoom: RAINVIEWER_MAX_NATIVE_ZOOM,
        errorTileUrl: BLANK_TILE,
        opacity: .78
      }).addTo(r.map);
      r.lastCenter = center.slice();
      setLayer(r.layer || 'rain', true);
    } else {
      const moved = !r.lastCenter || r.lastCenter[0] !== center[0] || r.lastCenter[1] !== center[1];
      if (moved) {
        r.map.setView(center, 7);
        r.marker.setLatLng(center);
        r.circle.setLatLng(center);
        r.lastCenter = center.slice();
      }
      if (r.marker && r.marker.setPopupContent) {
        r.marker.setPopupContent('<strong>' + esc(d.location.name) + '</strong><br>Current location');
      }
      setLayer(r.layer || 'rain');
    }
    if (r.layer === 'rain' && r.frames.length) {
      syncRadarSlider();
      updateFrameLabel();
      scheduleRadarFrame();
    }
    requestAnimationFrame(() => {
      try { r.map.invalidateSize(); } catch (e) { /* map is parked or detached */ }
    });
  }

  function tileUrl(layer) {
    return CFG.urls.tile.replace('/LAYER/', '/' + layer + '/').replace('/0/0/0.png', '/{z}/{x}/{y}.png');
  }

  function cartoBasemapUrl() {
    const base = 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png';
    const key = CFG.cartoKey || '';
    return key ? base + '?key=' + encodeURIComponent(key) : base;
  }

  function setOverlayUrl(url) {
    const r = S.radar;
    if (!r.overlay || r.overlayUrl === url) return;
    r.overlay.setUrl(url);
    r.overlayUrl = url;
  }

  function frameUrl() {
    const r = S.radar;
    const frame = r.frames[r.index] || r.frames[r.frames.length - 1];
    return frame && r.host ? r.host + frame.path + '/256/{z}/{x}/{y}/2/1_1.png' : BLANK_TILE;
  }

  function setLayer(layer, force) {
    const r = S.radar;
    if (!layer) layer = 'rain';
    const changed = !!force || r.layer !== layer;
    r.layer = layer;
    syncRadarControls();
    if (!r.map || !r.overlay || !changed) return;

    if (layer === 'rain') {
      r.overlay.options.maxNativeZoom = RAINVIEWER_MAX_NATIVE_ZOOM;
      r.overlay.setOpacity(.78);
      if (r.frames.length) {
        setOverlayUrl(frameUrl());
        updateFrameLabel();
      } else {
        setOverlayUrl(BLANK_TILE);
        loadRadarIndex();
      }
    } else {
      r.overlay.options.maxNativeZoom = CARTO_MAX_ZOOM;
      r.overlay.setOpacity(.8);
      setOverlayUrl(tileUrl(layer));
    }
  }

  function syncRadarSlider() {
    const r = S.radar;
    const slider = $('#frameSlider');
    if (!slider) return;
    slider.max = String(Math.max(0, r.frames.length - 1));
    slider.value = String(r.index);
    slider.disabled = !r.frames.length;
  }

  function updateFrameLabel() {
    const r = S.radar;
    const label = $('#frameLabel');
    const frame = r.frames[r.index];
    if (!label || !frame) return;
    label.textContent = new Date(frame.time * 1000).toLocaleString(undefined, {
      weekday: 'short', hour: '2-digit', minute: '2-digit'
    }) + (frame.type === 'nowcast' ? ' · forecast' : '');
  }

  function updateRadarFrame() {
    const r = S.radar;
    if (!r.map || !r.overlay || r.layer !== 'rain' || !r.frames.length) return;
    setOverlayUrl(frameUrl());
    updateFrameLabel();
  }

  function scheduleRadarFrame() {
    const r = S.radar;
    if (r.frameRaf) cancelAnimationFrame(r.frameRaf);
    if (document.hidden) return;
    r.frameRaf = requestAnimationFrame(() => {
      r.frameRaf = 0;
      updateRadarFrame();
    });
  }

  async function loadRadarIndex(force) {
    const r = S.radar;
    if (!r.map || r.layer !== 'rain') return;
    if (!force && r.frames.length && Date.now() - r.indexFetchedAt < RADAR_INDEX_TTL) {
      syncRadarSlider();
      scheduleRadarFrame();
      return;
    }
    if (r.indexPromise) return r.indexPromise;
    const token = ++r.indexToken;
    const task = (async () => {
      try {
        const res = await api(CFG.urls.radar);
        if (token !== r.indexToken || r.layer !== 'rain') return;
        if (!res.ok || !res.frames || !res.frames.length) {
          const label = $('#frameLabel');
          if (label) label.textContent = 'Radar feed unavailable';
          return;
        }
        r.frames = res.frames;
        r.host = res.host;
        r.index = res.frames.length - 1;
        r.indexFetchedAt = Date.now();
        syncRadarSlider();
        scheduleRadarFrame();
      } catch (e) {
        if (token !== r.indexToken) return;
        const label = $('#frameLabel');
        if (label) label.textContent = 'Radar feed unavailable';
      } finally {
        if (r.indexPromise === task) r.indexPromise = null;
      }
    })();
    r.indexPromise = task;
    return task;
  }

  /* ---------------- AIR QUALITY ---------------- */
  function renderAir(d) {
    const root = $('#pageRoot'); if (!root) return;
    const air = d.air;
    if (!air) {
      root.innerHTML = '<div class="empty"><i class="fa-solid fa-wind"></i><h3>Air quality unavailable</h3><p>The air pollution feed did not return data for ' + esc(d.location.name) + '. No values are shown rather than guessed.</p></div>';
      return;
    }
    const segs = [
      { color: '#4ade80' }, { color: '#a3e635' }, { color: '#fbbf24' }, { color: '#fb923c' }, { color: '#f87171' }
    ];
    const compMeta = [
      ['pm2_5', 'PM2.5', 'Fine particles', 75], ['pm10', 'PM10', 'Coarse particles', 150],
      ['co', 'CO', 'Carbon monoxide', 4000], ['no2', 'NO₂', 'Nitrogen dioxide', 200],
      ['o3', 'O₃', 'Ozone', 200], ['so2', 'SO₂', 'Sulfur dioxide', 150]
    ];
    const cards = compMeta.filter(x => air.components[x[0]] != null).map(x => {
      const v = air.components[x[0]];
      const pct = Math.min(100, (v / x[3]) * 100);
      return '<div class="card pollutant"><div class="pollutant-top"><div><div class="pollutant-name">' + x[1] + '</div><div class="pollutant-formula">' + x[2] + '</div></div><i class="fa-solid fa-circle" style="color:' + air.color + ';font-size:9px"></i></div>' +
        '<div class="pollutant-value">' + Number(v).toFixed(1) + '<small>µg/m³</small></div><div class="pollutant-bar"><i style="--bar-scale:' + (pct / 100).toFixed(3) + ';background:' + air.color + '"></i></div></div>';
    }).join('');
    root.innerHTML =
      '<section class="section"><div class="card air-hero"><div class="gauge-wrap" id="aqiGauge"></div>' +
      '<div><div class="card-kicker">Current air quality · ' + esc(d.location.name) + '</div><div class="air-category" style="color:' + air.color + '">' + esc(air.label) + '</div>' +
      '<div class="air-advice">' + esc(air.advice) + '</div><div class="aqi-scale">' + segs.map((s, i) => '<div class="' + (i === air.aqi - 1 ? 'active' : '') + '" style="background:' + s.color + '"></div>').join('') + '</div>' +
      '<div class="aqi-scale-labels"><span>Good</span><span>Fair</span><span>Moderate</span><span>Poor</span><span>Very poor</span></div></div></div></section>' +
      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-flask"></i> Pollutant breakdown</div><div class="section-note">' + esc(air.units) + ' · measured ' + (air.dt ? clock(localDate(air.dt)) : ' recently') + '</div></div></div>' +
      '<div class="pollutant-grid">' + cards + '</div></section>' +
      '<section class="section"><div class="card card-pad"><div class="card-kicker"><i class="fa-solid fa-heart-pulse"></i> Health guidance</div>' +
      '<div class="tip-list"><div class="tip"><i class="fa-solid fa-circle-check"></i><span>' + esc(air.advice) + '</span></div>' +
      '<div class="tip"><i class="fa-solid fa-house"></i><span>Keep windows closed during peak pollution periods if you are sensitive to air quality changes.</span></div>' +
      '<div class="tip"><i class="fa-solid fa-circle-info"></i><span>Values come from the OpenWeatherMap Air Pollution feed and may be model estimates rather than station readings.</span></div></div></div></section>';

    Charts.gauge($('#aqiGauge'), { value: air.aqi, max: 5, segments: segs, activeIndex: air.aqi - 1, label: 'Air quality gauge' });
  }

  /* ---------------- SETTINGS ---------------- */
  function segment(key, options, current) {
    return '<div class="segmented" data-setting="' + key + '">' + options.map(o =>
      '<button class="' + (current === o[0] ? 'active' : '') + '" data-value="' + o[0] + '">' + o[1] + '</button>').join('') + '</div>';
  }
  function toggle(key, checked) {
    return '<label class="switch"><input type="checkbox" data-setting="' + key + '" ' + (checked ? 'checked' : '') + '><span class="track"></span></label>';
  }
  function renderSettings() {
    const root = $('#pageRoot'); if (!root) return;
    const s = S.settings;
    root.innerHTML =
      '<div class="settings-grid">' +
        '<div class="card settings-card"><h2><i class="fa-solid fa-ruler"></i> Units &amp; time</h2><p class="hint">Applied instantly across every page.</p>' +
          '<div class="setting-row"><div class="setting-info"><div class="label">Temperature</div><div class="desc">Celsius or Fahrenheit</div></div>' + segment('temperature_unit', [['C', '°C'], ['F', '°F']], s.temperature_unit) + '</div>' +
          '<div class="setting-row"><div class="setting-info"><div class="label">Distance &amp; wind</div><div class="desc">Kilometres / metres per second or miles / mph</div></div>' + segment('distance_unit', [['km', 'km · m/s'], ['mi', 'mi · mph']], s.distance_unit) + '</div>' +
          '<div class="setting-row"><div class="setting-info"><div class="label">Time format</div><div class="desc">12-hour or 24-hour clock</div></div>' + segment('hour_format', [['24', '24 h'], ['12', '12 h']], s.hour_format) + '</div>' +
          '<div class="setting-row"><div class="setting-info"><div class="label">Language</div><div class="desc">Interface labels</div></div><select class="form-select" data-setting="language">' +
            [['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch']].map(o => '<option value="' + o[0] + '" ' + (s.language === o[0] ? 'selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
        '</div>' +
        '<div class="card settings-card"><h2><i class="fa-solid fa-palette"></i> Appearance</h2><p class="hint">Choose how Aether Weather looks.</p>' +
          '<div class="setting-row"><div class="setting-info"><div class="label">Theme</div><div class="desc">Light daylight or dark atmospheric · saved on this browser</div></div>' + segment('theme', [['light', 'Light'], ['dark', 'Dark']], s.theme) + '</div>' +
          '<div class="setting-row"><div class="setting-info"><div class="label">Refresh interval</div><div class="desc">How often live data is reloaded</div></div><select class="form-select" data-setting="refresh_minutes">' +
            [[5, 'Every 5 minutes'], [10, 'Every 10 minutes'], [30, 'Every 30 minutes'], [0, 'Manual only']].map(o => '<option value="' + o[0] + '" ' + (Number(s.refresh_minutes) === o[0] ? 'selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
        '</div>' +
        '<div class="card settings-card"><h2><i class="fa-solid fa-location-crosshairs"></i> Location</h2><p class="hint">Location is only requested when you click the button.</p>' +
          '<div class="setting-row"><div class="setting-info"><div class="label">Device location</div><div class="desc">Uses the browser Geolocation API. No IP-based location is used.</div></div><button class="btn btn-sm" id="locateBtn"><i class="fa-solid fa-crosshairs"></i> ' + locationButtonLabel() + '</button></div>' +
          '<div class="setting-row"><div class="setting-info"><div class="label">Manual city</div><div class="desc">Search from the top bar any time; manual choices stay on this browser.</div></div><button class="btn btn-sm" id="settingsSearchBtn"><i class="fa-solid fa-magnifying-glass"></i> Search city</button></div>' +
        '</div>' +
        '<div class="card settings-card"><h2><i class="fa-solid fa-bell"></i> Notifications</h2><p class="hint">Browser alerts are only sent when real conditions match.</p>' +
          '<div class="setting-row"><div class="setting-info"><div class="label">Browser notifications</div><div class="desc">Enable system notifications</div></div><button class="btn btn-sm" id="notifBtn">' + (typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'Enabled' : 'Enable') + '</button></div>' +
          ['rain', 'alerts', 'air'].map(k => '<div class="setting-row"><div class="setting-info"><div class="label">' + ({ rain: 'Rain warnings', alerts: 'Severe weather alerts', air: 'Poor air quality' }[k]) + '</div><div class="desc">' + ({ rain: 'Notify when rain chance is 70% or more', alerts: 'Notify when an official alert is active', air: 'Notify when AQI reaches 4 or 5' }[k]) + '</div></div>' + toggle('notif_' + k, s.notifications[k]) + '</div>').join('') +
        '</div></div><div class="setting-status" id="settingStatus"></div>';

    $$('[data-setting]', root).forEach(el => {
      if (el.classList.contains('segmented')) {
        $$('button', el).forEach(b => b.addEventListener('click', () => {
          $$('button', el).forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          onSettingChange(el.getAttribute('data-setting'), b.getAttribute('data-value'));
        }));
      } else if (el.type === 'checkbox') {
        el.addEventListener('change', () => {
          if (el.getAttribute('data-setting').startsWith('notif_')) {
            const prefs = Object.assign({}, S.settings.notifications);
            prefs[el.getAttribute('data-setting').replace('notif_', '')] = el.checked;
            onSettingChange('notifications', prefs);
          } else onSettingChange(el.getAttribute('data-setting'), el.checked);
        });
      } else {
        el.addEventListener('change', () => onSettingChange(el.getAttribute('data-setting'), el.value));
      }
    });
    $('#locateBtn').addEventListener('click', enableLocation);
    $('#settingsSearchBtn').addEventListener('click', openModal);
    $('#notifBtn').addEventListener('click', async () => {
      if (typeof Notification === 'undefined') { toast('This browser does not support notifications', 'error'); return; }
      const p = await Notification.requestPermission();
      $('#notifBtn').textContent = p === 'granted' ? 'Enabled' : 'Blocked';
      toast(p === 'granted' ? 'Notifications enabled' : 'Notification permission denied', p === 'granted' ? 'success' : 'error');
    });
  }
  function onSettingChange(key, value) {
    const patch = {};
    patch[key] = value;
    saveSettings(patch);
    const st = $('#settingStatus'); if (st) st.textContent = '✓ Preferences saved';
    if (key === 'hour_format' || key === 'temperature_unit' || key === 'distance_unit') renderPage();
  }

  /* ---------------- INSIGHTS ---------------- */
  function renderInsights(d) {
    const root = $('#pageRoot'); if (!root) return;
    const insights = window.InsightEngine ? InsightEngine.build(d) : [];
    root.innerHTML =
      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-lightbulb"></i> Weather insights for ' + esc(d.location.name) + '</div><div class="section-note">Generated from live forecast data — no invented values</div></div></div>' +
      '<div class="insight-grid">' + insights.map(i =>
        '<div class="card insight-card ' + esc(i.tone) + '"><div class="insight-icon"><i class="fa-solid fa-' + esc(i.icon) + '"></i></div><div><div class="insight-title">' + esc(i.title) + '</div><div class="insight-text">' + esc(i.text) + '</div></div></div>').join('') + '</div></section>' +
      '<section class="section"><div class="card chat-card"><div class="chat-head"><div class="chat-avatar"><i class="fa-solid fa-wand-magic-sparkles"></i></div>' +
      '<div><div class="t">Weather assistant</div><div class="s">● AI-powered · using live data for ' + esc(d.location.name) + '</div></div></div>' +
      '<div class="chat-body" id="chatBody"><div class="msg bot">Hi! Ask me about today’s rain, travel conditions, the best time to go outside, or tomorrow’s temperature. My answers use the live forecast for ' + esc(d.location.name) + '.</div></div>' +
      '<div class="chat-suggestions">' + ['Will it rain today?', 'Is today suitable for travelling?', 'Should I carry an umbrella?', 'What is the best time to go outside?', 'Is tomorrow hotter than today?'].map(q => '<button data-q="' + esc(q) + '">' + esc(q) + '</button>').join('') + '</div>' +
      '<form class="chat-input-row" id="chatForm"><input class="chat-input" id="chatInput" placeholder="Ask about the weather…" autocomplete="off"><button class="btn btn-primary" type="submit"><i class="fa-solid fa-paper-plane"></i></button></form></div></section>';

    $$('[data-q]', root).forEach(b => b.addEventListener('click', () => askQuestion(b.getAttribute('data-q'))));
    $('#chatForm').addEventListener('submit', e => {
      e.preventDefault();
      const input = $('#chatInput');
      askQuestion(input.value);
      input.value = '';
    });
  }
  async function askQuestion(question) {
    if (!question || !question.trim()) return;
    const body = $('#chatBody');
    body.insertAdjacentHTML('beforeend', '<div class="msg user">' + esc(question) + '</div>');
    const typing = document.createElement('div');
    typing.className = 'msg bot';
    typing.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Checking live data…';
    body.appendChild(typing);
    body.scrollTop = body.scrollHeight;
    const cleanQuestion = question.trim();
    const payload = { question: cleanQuestion, history: S.assistant.history.slice(-6) };
    if (S.active && S.active.lat != null) { payload.lat = S.active.lat; payload.lon = S.active.lon; }
    else payload.city = (S.active && S.active.name) || (S.data && S.data.location.name);
    let res;
    try {
      res = await api(CFG.urls.assistant, { method: 'POST', body: payload });
    } catch (e) {
      res = { ok: false, error: 'Unable to reach the assistant. Please try again.' };
    }
    if (res.ok) {
      S.assistant.history.push({ question: cleanQuestion, answer: res.answer });
      if (S.assistant.history.length > 6) S.assistant.history.shift();
    }
    typing.innerHTML = res.ok ? esc(res.answer) + '<span class="source">' + esc(res.source) + '</span>' : '<span style="color:var(--red)">' + esc(res.answer || res.error || 'Unable to answer right now.') + '</span>';
    body.scrollTop = body.scrollHeight;
  }

  /* ---------------- ASTRONOMY ---------------- */
  function renderAstronomy(d) {
    const root = $('#pageRoot'); if (!root) return;
    const a = d.astronomy, m = a.moon;
    const nowSec = Date.now() / 1000;
    const progress = a.sunrise && a.sunset ? Math.max(0, Math.min(1, (nowSec - a.sunrise) / (a.sunset - a.sunrise))) : .5;
    root.innerHTML =
      '<div class="astro-grid"><div class="card moon-card"><div class="card-kicker"><i class="fa-solid fa-moon"></i> Moon phase</div><div id="moonVisual"></div>' +
      '<div class="moon-name">' + esc(m.name) + '</div><div class="moon-illum">' + m.illumination + '% illuminated · ' + m.age_days + ' days into cycle</div>' +
      '<div class="moon-facts"><div class="mini-stat"><span class="label"><i class="fa-solid fa-arrow-up-right"></i> Moonrise</span><span class="value">' + (m.moonrise_label || '—') + ' <span class="tiny muted">est.</span></span></div>' +
      '<div class="mini-stat"><span class="label"><i class="fa-solid fa-arrow-down-right"></i> Moonset</span><span class="value">' + (m.moonset_label || '—') + ' <span class="tiny muted">est.</span></span></div></div>' +
      '<div class="estimate-note"><i class="fa-solid fa-circle-info"></i><span>Moon phase and illumination are calculated from the synodic lunar cycle. Moonrise and moonset are estimates derived from phase and sunrise because the current data plan does not supply them directly.</span></div></div>' +
      '<div class="card sun-card"><div class="card-kicker"><i class="fa-solid fa-sun"></i> Sun path · ' + esc(d.location.name) + '</div><div id="sunArc"></div>' +
      '<div class="sun-times"><div class="sun-time"><div class="label">Sunrise</div><div class="value">' + (a.sunrise_label || '—') + '</div><div class="sub">Local time</div></div>' +
      '<div class="sun-time"><div class="label">Sunset</div><div class="value">' + (a.sunset_label || '—') + '</div><div class="sub">Local time</div></div>' +
      '<div class="sun-time"><div class="label">Daylight</div><div class="value">' + (a.daylight_hours || '—') + ' h</div><div class="sub">Sun above horizon</div></div></div>' +
      '<div class="mini-stat" style="margin-top:18px"><span class="label"><i class="fa-solid fa-sun-plan"></i> Golden hour (estimated)</span><span class="value">' + (a.golden_hour_label || '—') + '</span></div>' +
      '<div class="estimate-note"><i class="fa-solid fa-circle-info"></i><span>Sunrise and sunset are live values from the weather feed. Golden hour is estimated as the hour before sunset.</span></div></div></div>';
    Charts.moon($('#moonVisual'), { illumination: m.illumination, waxing: m.waxing, name: m.name });
    Charts.sunArc($('#sunArc'), { progress: progress, sunrise: a.sunrise_label, sunset: a.sunset_label });
  }

  /* ---------------- ALERTS ---------------- */
  function renderAlerts(d) {
    const root = $('#pageRoot'); if (!root) return;
    const a = d.alerts;
    const rules = getRules();
    const items = a.supported ? a.items.map(al => {
      const sev = String(al.severity || 'unknown').toLowerCase();
      const color = sev === 'extreme' ? '#f87171' : sev === 'severe' ? '#fb923c' : sev === 'moderate' ? '#fbbf24' : '#78a9ff';
      return '<div class="card alert-item"><div class="alert-item-head"><span class="alert-severity" style="color:' + color + ';background:' + color + '22">' + esc(al.severity) + '</span><h3>' + esc(al.event) + '</h3></div>' +
        '<div class="alert-desc">' + esc(al.description || 'No description provided.') + '</div><div class="alert-meta">' +
        (al.area ? '<span><i class="fa-solid fa-location-dot"></i> ' + esc(al.area) + '</span>' : '') +
        (al.start ? '<span><i class="fa-solid fa-clock"></i> From ' + esc(new Date(al.start).toLocaleString()) + '</span>' : '') +
        (al.end ? '<span><i class="fa-solid fa-hourglass-end"></i> Until ' + esc(new Date(al.end).toLocaleString()) + '</span>' : '') +
        '</div></div>';
    }).join('') : '';

    root.innerHTML =
      (a.supported
        ? '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-triangle-exclamation"></i> Active alerts · ' + esc(a.source) + '</div><div class="section-note">' + a.items.length + ' official alert(s) for ' + esc(d.location.name) + '</div></div></div>' + (items || '<div class="empty"><i class="fa-solid fa-shield-halved"></i><h3>No active alerts</h3><p>No severe weather warnings are currently in effect for this location.</p></div>') + '</section>'
        : '<section class="section"><div class="alert-banner info"><i class="fa-solid fa-circle-info"></i><div><div class="t">Alert information unavailable for this region</div><div class="d">' + esc(a.reason) + '</div></div></div></section>') +
      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-bell"></i> Custom notification rules</div><div class="section-note">Stored on this device · evaluated against live data</div></div></div>' +
      '<div class="card card-pad"><div class="rule-row"><div class="setting-info"><div class="label">Heavy rain</div><div class="desc">Alert when rain probability meets your threshold</div></div><div style="display:flex;align-items:center;gap:10px"><input class="form-input" id="rainThreshold" type="number" min="10" max="100" step="5" value="' + rules.rain + '" style="width:70px"><span class="tiny muted">% chance</span></div></div>' +
      '<div class="rule-row"><div class="setting-info"><div class="label">Strong wind</div><div class="desc">Alert when wind speed meets your threshold</div></div><div style="display:flex;align-items:center;gap:10px"><input class="form-input" id="windThreshold" type="number" min="1" max="50" step="1" value="' + rules.wind + '" style="width:70px"><span class="tiny muted">' + (S.settings.distance_unit === 'mi' ? 'mph' : 'm/s') + '</span></div></div>' +
      '<div class="rule-row"><div class="setting-info"><div class="label">Official severe alerts</div><div class="desc">Notify whenever an official warning is active</div></div><label class="switch"><input type="checkbox" id="alertRuleEnabled" ' + (rules.alerts ? 'checked' : '') + '><span class="track"></span></label></div>' +
      '<div style="margin-top:18px"><button class="btn btn-primary btn-sm" id="saveRules"><i class="fa-solid fa-check"></i> Save rules</button> <a class="text-link" href="/settings/" style="margin-left:12px">Notification settings</a></div></div></section>';

    $('#saveRules').addEventListener('click', () => {
      const next = {
        rain: Math.max(10, Math.min(100, Number($('#rainThreshold').value) || 70)),
        wind: Math.max(1, Math.min(50, Number($('#windThreshold').value) || 15)),
        alerts: $('#alertRuleEnabled').checked
      };
      cachedRules = next;
      localStorage.setItem('aether_alert_rules', JSON.stringify(next));
      toast('Notification rules saved');
    });
  }
  function getRules(force) {
    if (!force && cachedRules) return cachedRules;
    const defaults = { rain: 70, wind: 15, alerts: true };
    try { cachedRules = Object.assign(defaults, JSON.parse(localStorage.getItem('aether_alert_rules') || '{}')); }
    catch (e) { cachedRules = defaults; }
    return cachedRules;
  }
  function evaluateNotifications() {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !S.data) return;
    const rules = getRules(), d = S.data;
    const pop = Math.max(0, ...d.hourly.map(h => h.pop == null ? 0 : h.pop));
    const candidates = [];
    if (S.settings.notifications.rain && pop >= rules.rain) candidates.push(['rain', 'Rain expected', 'Up to ' + pop + '% chance of rain in ' + d.location.name + '.']);
    if (S.settings.notifications.alerts && rules.alerts && d.alerts.supported && d.alerts.items.length) candidates.push(['alert', 'Weather alert', d.alerts.items[0].event + ' — ' + d.location.name]);
    if (S.settings.notifications.air && d.air && d.air.aqi >= 4) candidates.push(['air', 'Poor air quality', 'AQI ' + d.air.aqi + ' (' + d.air.label + ') in ' + d.location.name]);
    const wind = d.current.wind_speed || 0;
    const windMs = S.settings.distance_unit === 'mi' ? wind * 0.44704 : wind;
    if (windMs >= rules.wind) candidates.push(['wind', 'Strong wind', 'Wind ' + speed(wind) + ' in ' + d.location.name]);
    candidates.forEach(c => {
      if (S.notified.has(c[0])) return;
      S.notified.add(c[0]);
      try { new Notification(c[1], { body: c[2], icon: '' }); } catch (e) { /* some browsers block */ }
    });
  }

  /* ---------------- UV ---------------- */
  function renderUV(d) {
    const root = $('#pageRoot'); if (!root) return;
    const uv = d.uv, a = d.astronomy;
    const segs = [
      { color: '#4ade80' }, { color: '#a3e635' }, { color: '#fbbf24' }, { color: '#fb923c' }, { color: '#f87171' }, { color: '#c084fc' }
    ];
    const tips = uv && uv.value >= 6
      ? ['Use a broad-spectrum sunscreen with SPF 30 or higher.', 'Wear a hat and sunglasses, and seek shade around midday.', 'Limit prolonged sun exposure, especially between 11 AM and 3 PM.']
      : [' sunscreen is generally unnecessary at this UV level, but prolonged exposure still adds up.', 'Check the UV index again if you will be outside for several hours.', 'Hats and sunglasses remain useful for comfort.'];
    root.innerHTML =
      '<section class="section"><div class="card uv-hero"><div class="uv-gauge"><div id="uvGauge"></div><div class="value" style="color:' + (uv ? uv.color : 'var(--text)') + '">' + (uv ? uv.value : '—') + '</div><div class="level">' + (uv ? esc(uv.level) : 'Data unavailable') + '</div>' +
      '<div class="uv-scale">' + segs.map((s, i) => '<div class="' + (uv && i === Math.min(5, Math.floor(uv.value / 2)) ? 'active' : '') + '" style="background:' + s.color + '"></div>').join('') + '</div>' +
      '<div class="uv-scale-labels"><span>0-2</span><span>2-4</span><span>4-6</span><span>6-8</span><span>8-11</span><span>11+</span></div></div>' +
      '<div><div class="card-kicker"><i class="fa-solid fa-sun"></i> Current UV · ' + esc(d.location.name) + '</div>' +
      '<div class="air-advice">' + (uv ? 'The UV index is a real-time observation from the weather provider. Values of 6 and above call for sun protection.' : 'The UV feed did not return a value for this location, so nothing is displayed rather than an invented number.') + '</div>' +
      '<div class="alert-banner info" style="margin-top:18px"><i class="fa-solid fa-circle-info"></i><div><div class="t">Hourly UV forecast unavailable</div><div class="d">The available API plan provides only the current UV observation, not an hourly UV series.</div></div></div></div></div></section>' +
      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-shield-halved"></i> Sun protection</div></div></div><div class="card card-pad"><div class="tip-list">' +
      tips.map(t => '<div class="tip"><i class="fa-solid fa-circle-check"></i><span>' + esc(t.trim()) + '</span></div>').join('') + '</div></div></section>' +
      '<section class="section"><div class="section-head"><div><div class="section-title"><i class="fa-solid fa-sunrise"></i> Sun information</div></div></div><div class="card card-pad">' +
      '<div class="sun-times"><div class="sun-time"><div class="label">Sunrise</div><div class="value">' + (a.sunrise_label || '—') + '</div></div>' +
      '<div class="sun-time"><div class="label">Sunset</div><div class="value">' + (a.sunset_label || '—') + '</div></div>' +
      '<div class="sun-time"><div class="label">Daylight</div><div class="value">' + (a.daylight_hours || '—') + ' h</div></div></div></div></section>';
    Charts.gauge($('#uvGauge'), { value: uv ? uv.value : 0, max: 12, segments: segs, activeIndex: uv ? Math.min(5, Math.floor(uv.value / 2)) : -1, label: 'UV index gauge' });
  }

  /* ---------------- search / modal ---------------- */
  function cancelSearch() {
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
    if (searchAbort) { searchAbort.abort(); searchAbort = null; }
    searchRequestId++;
  }
  function openModal() {
    const m = $('#searchModal');
    if (!m) return;
    cancelSearch();
    m.classList.add('open');
    const input = $('#searchInput');
    input.value = '';
    renderSearchHistory();
    if (searchFocusTimer) clearTimeout(searchFocusTimer);
    searchFocusTimer = setTimeout(() => { searchFocusTimer = null; input.focus(); }, 60);
  }
  function closeModal() {
    cancelSearch();
    const m = $('#searchModal');
    if (m) m.classList.remove('open');
  }
  function renderSearchHistory() {
    const box = $('#searchResults');
    if (!box) return;
    if (!S.searchHistory.length) {
      box.innerHTML = '<div class="search-hint">Type at least two characters to search cities worldwide.</div>';
      return;
    }
    box.innerHTML = '<div class="search-hint search-hint-label" style="padding-bottom:6px">Recent searches</div>' + S.searchHistory.map(h =>
      '<div class="search-result" data-history-id="' + h.id + '">' +
      '<i class="fa-solid fa-location-dot"></i>' +
      '<div class="search-result-text"><div class="r-name">' + esc(h.name) + '</div><div class="r-region">' + esc([h.region, h.country].filter(Boolean).join(', ') || 'Recently searched') + '</div></div>' +
      '<button class="search-result-remove" type="button" data-remove-history="' + h.id + '" title="Remove ' + esc(h.name) + ' from search history" aria-label="Remove ' + esc(h.name) + ' from search history"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>' +
      '</div>').join('');
    $$('[data-remove-history]', box).forEach(el => el.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const removed = removeSearchHistory(el.getAttribute('data-remove-history'));
      if (!removed) { toast('Search history entry not found.', 'error'); return; }
      renderSearchHistory();
    }));
    $$('[data-history-id]', box).forEach(el => el.addEventListener('click', e => {
      if (e.target.closest('[data-remove-history]')) return;
      const h = S.searchHistory.find(x => Number(x.id) === Number(el.getAttribute('data-history-id')));
      if (h) selectLocation(h);
    }));
  }
  async function doSearch(q) {
    const query = String(q || '').trim();
    const box = $('#searchResults');
    if (query.length < 2) {
      cancelSearch();
      renderSearchHistory();
      return;
    }
    if (!box) return;
    if (searchAbort) searchAbort.abort();
    const requestId = ++searchRequestId;
    const controller = new AbortController();
    searchAbort = controller;
    box.innerHTML = '<div class="search-hint"><i class="fa-solid fa-spinner fa-spin"></i> Searching…</div>';
    try {
      const res = await api(CFG.urls.search + '?q=' + encodeURIComponent(query), { signal: controller.signal });
      if (requestId !== searchRequestId) return;
      const results = res.results || [];
      if (!results.length) {
        box.innerHTML = '<div class="search-hint">No cities found for “' + esc(query) + '”.</div>';
        return;
      }
      box.innerHTML = results.map((r, i) =>
        '<div class="search-result" data-result="' + i + '"><i class="fa-solid fa-location-dot"></i><div><div class="r-name">' + esc(r.name) + '</div><div class="r-region">' + esc([r.state, r.country].filter(Boolean).join(', ')) + '</div></div><span class="r-add">Add +</span></div>').join('');
      $$('[data-result]', box).forEach(el => el.addEventListener('click', () => {
        const r = results[Number(el.getAttribute('data-result'))];
        const added = addSavedCity(r);
        if (!added.location) { toast('Could not add city', 'error'); return; }
        if (added.existing) {
          toast(added.location.name + ' is already saved');
        } else {
          toast(added.location.name + ' added to your locations');
        }
        selectLocation(added.location);
      }));
    } catch (err) {
      if (requestId !== searchRequestId || isAbortError(err)) return;
      box.innerHTML = '<div class="search-hint">Search is unavailable right now. Please try again.</div>';
    } finally {
      if (searchAbort === controller) searchAbort = null;
    }
  }

  async function enableLocation() {
    if (locating) return;
    locating = true;
    closeModal();

    // Paint the centred loading state before any asynchronous work starts.
    S.data = null;
    S.active = null;
    updateTopbar();
    showAppLoading('Detecting your location...');
    setLocating(true, 'Detecting location…');

    try {
      if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== 'function') {
        showLocationError('unavailable');
        toast('This browser does not support device location.', 'error');
        return;
      }
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 60000
        });
      });
      const lat = pos && pos.coords ? pos.coords.latitude : null;
      const lon = pos && pos.coords ? pos.coords.longitude : null;
      if (!isFinite(lat) || !isFinite(lon)) {
        throw new Error('No coordinates were returned');
      }
      S.active = normalizeCity({ lat: lat, lon: lon, source: 'gps' });
      S.locationEnabled = true;
      scheduleRefresh();
      const alert = $('#globalAlert');
      if (alert) alert.innerHTML = '';
      setAppLoadingMessage('Loading weather data...');
      await loadData(true);
    } catch (err) {
      const code = err && err.code;
      if (code === 1 || (err && err.PERMISSION_DENIED === 1)) {
        showLocationError('denied');
        toast('Location permission denied.', 'error');
      } else if (code === 2 || code === 3) {
        showLocationError('unavailable');
        toast('Location unavailable.', 'error');
      } else {
        showLocationError('error', err && err.message ? err.message : '');
        toast('Could not read your location.', 'error');
      }
    } finally {
      hideAppLoading();
      setLocating(false);
      locating = false;
    }
  }

  /* ---------------- smooth page navigation ---------------- */
  const PAGE_PATHS = {
    '/': 'home', '/forecast/': 'forecast', '/radar/': 'radar',
    '/air-quality/': 'air', '/settings/': 'settings', '/insights/': 'insights',
    '/astronomy/': 'astronomy', '/alerts/': 'alerts', '/uv/': 'uv'
  };
  let navRequestId = 0;

  function normalizedPath(pathname) {
    const trimmed = String(pathname || '').replace(/\/+$/, '');
    return trimmed ? trimmed + '/' : '/';
  }

  function pageFromHref(href) {
    const url = new URL(href, location.href);
    return PAGE_PATHS[normalizedPath(url.pathname)] || null;
  }

  function isNavigableLink(link) {
    const href = link.getAttribute('href');
    if (!href || href.charAt(0) === '#') return false;
    if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return false;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return false;
    return !!pageFromHref(url.href);
  }

  async function navigateTo(href, page, push) {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) { window.location.href = href; return; }
    const pageName = page || pageFromHref(url.href) || 'home';
    const current = $('#pageView');
    const currentPage = current ? current.getAttribute('data-page') : CFG.page;
    if (!url.hash && pageName === currentPage && url.pathname === location.pathname && url.search === location.search) {
      // Clicking the active page must not refetch the same partial or rebuild
      // a live radar map just to scroll back to the top.
      if (push && url.href !== location.href) {
        history.pushState({ url: url.pathname + url.search, page: pageName }, '', url.pathname + url.search);
      }
      window.scrollTo(0, 0);
      return;
    }
    const requestId = ++navRequestId;
    const query = new URLSearchParams(url.search);
    query.set('partial', '1');
    query.set('_', String(Date.now()));
    const cleanUrl = url.pathname + url.search + url.hash;
    try {
      const res = await fetch(url.pathname + '?' + query.toString(), {
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      if (requestId !== navRequestId) return;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const view = doc.getElementById('pageView');
      if (!view) throw new Error('Page view missing');
      if (!current || !current.parentNode) throw new Error('Page view target missing');
      parkRadarMap();
      current.parentNode.replaceChild(document.importNode(view, true), current);

      const activePage = view.getAttribute('data-page') || pageName;
      CFG.page = activePage;
      document.body.setAttribute('data-page', activePage);
      const nextTitle = view.getAttribute('data-title') || doc.title;
      if (nextTitle) document.title = nextTitle;
      $$('[data-nav]').forEach(a => a.classList.toggle('active', a.getAttribute('data-nav') === activePage));
      $('#sidebar').classList.remove('open');
      $('#mobileOverlay').classList.remove('open');
      if (push) history.pushState({ url: cleanUrl, page: activePage }, '', cleanUrl);
      window.scrollTo(0, 0);
      renderPage();
    } catch (e) {
      if (requestId === navRequestId) window.location.href = cleanUrl;
    }
  }

  function bindNavigation() {
    document.addEventListener('click', e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!e.target || !e.target.closest) return;
      const link = e.target.closest('a');
      if (!link || !isNavigableLink(link)) return;
      e.preventDefault();
      navigateTo(link.href, link.getAttribute('data-nav') || pageFromHref(link.href), true);
    });
    window.addEventListener('popstate', e => {
      const state = e.state || {};
      navigateTo(state.url || location.href, state.page || pageFromHref(location.href), false);
    });
  }

  /* ---------------- boot ---------------- */
  function bindShell() {
    bindNavigation();
    $$('[data-nav]').forEach(a => { if (a.getAttribute('data-nav') === CFG.page) a.classList.add('active'); });
    $('#menuBtn').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#mobileOverlay').classList.add('open'); });
    $('#mobileOverlay').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#mobileOverlay').classList.remove('open'); });
    $('#searchBtn').addEventListener('click', openModal);
    $('#addLocBtn') && $('#addLocBtn').addEventListener('click', openModal);
    $$('[data-close-modal]').forEach(el => el.addEventListener('click', closeModal));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
    $('#locationTrigger').addEventListener('click', openModal);
    $('#themeBtn').addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      saveSettings({ theme: current === 'light' ? 'dark' : 'light' });
    });
    $('#refreshBtn').addEventListener('click', async () => {
      if (!S.locationEnabled || !S.data) {
        toast('Enable location or choose a city first', 'error');
        return;
      }
      const btn = $('#refreshBtn');
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      await loadData(false);
      btn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
      toast('Weather data refreshed');
    });
    $('#currentLocationBtn').addEventListener('click', enableLocation);
    $('#geoBtn').addEventListener('click', enableLocation);
    const input = $('#searchInput');
    input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(input.value), 280); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); doSearch(input.value); } });
  }

  function boot() {
    bindShell();
    // Render the usable shell immediately. Preferences hydrate in the
    // background so a slow settings request never blocks the empty state.
    S.settings = Object.assign({}, DEFAULT_CLIENT_SETTINGS);
    applyTheme(readTheme());
    loadLocations();
    loadSearchHistory();

    // No geolocation, no weather request and no pre-selected city on page load.
    // A previously saved city stays in storage but is not shown as the current
    // location until the visitor explicitly chooses it or enables GPS.
    try { localStorage.removeItem('aether_last_city'); } catch (e) { /* storage may be blocked */ }
    S.active = null;
    S.locationEnabled = false;
    updateLocationButtons();
    updateTopbar();
    renderSideLocations();
    startClock();
    renderPage();

    // Django messages from the original add-city form, surfaced as toasts.
    const legacy = document.getElementById('legacyMessages');
    if (legacy) {
      try {
        JSON.parse(legacy.textContent || '[]').forEach(m => toast(m.message, m.tags === 'error' ? 'error' : 'success'));
      } catch (e) { /* ignore malformed legacy payload */ }
    }

    loadSettings().catch(() => toast('Could not load saved preferences.', 'error'));
  }

  // Insights engine lives on window for the home + assistant pages.
  window.InsightEngine = {
    build: function (data) {
      // Mirrors the server-side rule set; the server is authoritative for chat.
      const out = [];
      const c = data.current || {}, h = data.hourly || [], d = data.daily || [];
      const pop = Math.max(0, ...h.map(x => x.pop == null ? 0 : x.pop));
      if (pop >= 70) out.push({ icon: 'umbrella', tone: 'rain', title: 'Rain is likely', text: 'Peak rain chance is ' + pop + '% in the next 24 hours.' });
      else if (pop >= 35) out.push({ icon: 'cloud-rain', tone: 'caution', title: 'Possible showers', text: 'Rain chance reaches ' + pop + '%.' });
      else out.push({ icon: 'sun', tone: 'good', title: 'Dry conditions', text: 'Rain chance stays around ' + pop + '%.' });
      if (c.temp != null) out.push({ icon: c.temp >= 30 ? 'temperature-high' : c.temp <= 5 ? 'snowflake' : 'check', tone: c.temp >= 30 ? 'warn' : c.temp <= 5 ? 'rain' : 'good', title: 'Current temperature', text: 'It is ' + temp(c.temp) + ' with a feels-like value of ' + temp(c.feels_like) + '.' });
      if (d.length >= 2) {
        const delta = Math.round(d[1].temp_max - d[0].temp_max);
        out.push({ icon: 'calendar', tone: 'neutral', title: 'Tomorrow', text: Math.abs(delta) < 1 ? 'Similar high to today.' : 'Forecast high is ' + Math.abs(delta) + '° ' + (delta > 0 ? 'warmer' : 'cooler') + ' than today.' });
      }
      return out;
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
