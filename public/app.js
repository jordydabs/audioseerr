/* AudioSeerr v2 – app.js  (r5) */
'use strict';

/* ── Auth ───────────────────────────────────────────────────────────────── */
let TOKEN = localStorage.getItem('as_token');
let ROLE  = localStorage.getItem('as_role');
let UNAME = localStorage.getItem('as_user');
// Remember where they were headed so a shared deep link survives the login
// round-trip instead of always dumping them on Discover.
if (!TOKEN) {
  const dest = location.pathname + location.search;
  window.location.href = '/login.html' + (dest && dest !== '/' ? `?next=${encodeURIComponent(dest)}` : '');
}

/* ── Server API helper ──────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${TOKEN}`, ...(opts.headers||{}) }
  });
  if (res.status === 401) { localStorage.clear(); window.location.href = '/login.html'; throw new Error('Session expired'); }
  const text = await res.text();
  let d = {};
  try { d = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(d.error || res.statusText || 'Request failed');
  return d;
}

/* ── Server-side preferences ────────────────────────────────────────────────
   UI choices (Discover sources, the admin "seen" marker) are stored on the
   server keyed by the logged-in user, so they persist permanently and sync to
   every browser/device — not just this one. We keep an in-memory copy and
   PUT merge-updates as things change. localStorage is only a fast fallback for
   the very first paint before the server responds. */
let PREFS = {
  discoverSources: { artists: 'deezer', albums: 'deezer', upcoming: 'itunes' },
  notifSeenAt: null
};
let prefsLoaded = false;   // true once the SERVER copy has been read at least once
async function loadPreferences() {
  try {
    const p = await api('/api/preferences');
    if (p && typeof p === 'object') {
      // notifSeenAt: keep whichever is NEWER — a save from this tab may still
      // be in flight, and the server enforces forward-only anyway.
      const localMs  = PREFS.notifSeenAt ? new Date(PREFS.notifSeenAt).getTime() : 0;
      const serverMs = p.notifSeenAt     ? new Date(p.notifSeenAt).getTime()     : 0;
      PREFS = {
        discoverSources: { ...PREFS.discoverSources, ...(p.discoverSources || {}) },
        notifSeenAt: serverMs >= localMs ? (p.notifSeenAt ?? null) : PREFS.notifSeenAt
      };
      prefsLoaded = true;
    }
  } catch (e) { console.warn('[prefs] load failed, using defaults:', e.message); }
  return PREFS;
}
/* Merge-save a partial preference patch. Fire-and-forget: the UI updates
   instantly and we don't block on the network. */
async function savePreferences(patch) {
  PREFS = {
    ...PREFS,
    ...patch,
    discoverSources: { ...PREFS.discoverSources, ...(patch.discoverSources || {}) }
  };
  try { await api('/api/preferences', { method: 'PUT', body: JSON.stringify(patch) }); }
  catch (e) { console.warn('[prefs] save failed:', e.message); }
}

/* ── Session keep-alive ─────────────────────────────────────────────────────
   This used to be a single setInterval of six days (with a comment claiming
   twenty), which no browser tab ever stays open long enough to fire — so the
   refresh path was effectively dead code and sessions simply ran to expiry.
   Refresh once on load and then every 12 hours, which a long-lived tab or a
   PWA actually reaches. The server re-reads the account on every refresh, so a
   demoted or deleted user cannot roll their session forward. */
async function refreshSession() {
  try {
    const r = await api('/api/auth/refresh', { method: 'POST' });
    if (r.token) {
      localStorage.setItem('as_token', r.token);
      TOKEN = r.token;
      if (r.role)     { localStorage.setItem('as_role', r.role); ROLE = r.role; }
      if (r.username) { localStorage.setItem('as_user', r.username); UNAME = r.username; }
    }
  } catch { /* transient — the existing token is still valid until it isn't */ }
}
setTimeout(refreshSession, 5000);
setInterval(refreshSession, 12 * 60 * 60 * 1000);

/* ── Toast ──────────────────────────────────────────────────────────────── */
function toast(msg, type='success') {
  const el = document.createElement('div');
  el.className  = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.opacity   = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 350);
  }, 4200);
}

/* ── Routing ──────────────────────────────────────────────────────────────
   Pages are now addressable: /search, /requests, /admin … The SPA fallback on
   the server already serves index.html for any non-/api path, so deep links,
   bookmarks, sharing, browser Back and the Android back gesture in the
   installed PWA all work — previously showPage() only toggled CSS classes, so
   a reload always dumped you back on Discover and Back exited the app. */
const PAGES = ['discover', 'mood', 'search', 'requests', 'downloads',
               'all-requests', 'users', 'api', 'settings'];
// The combined Admin page was split into Users and Settings; keep the old path
// resolving so a bookmark or shared /admin link still lands somewhere sensible.
const PAGE_ALIASES = { admin: 'settings' };
const resolvePage = n => PAGE_ALIASES[n] || n;

function showPage(name, opts = {}) {
  name = resolvePage(name);
  if (!PAGES.includes(name)) name = 'discover';
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  // querySelectorAll, not querySelector: the mobile nav is authored BEFORE the
  // sidebar in the DOM, so the single-match version always highlighted the
  // hidden mobile button and the visible desktop item never lit up.
  document.querySelectorAll('.nav-item[data-page]').forEach(n => n.classList.remove('active'));
  const pg = document.getElementById(`page-${name}`);
  if (pg) pg.classList.add('active');
  document.querySelectorAll(`.nav-item[data-page="${name}"]`).forEach(n => n.classList.add('active'));

  if (!opts.fromHistory) {
    const url = name === 'discover' ? '/' : `/${name}`;
    if (location.pathname !== url) history.pushState({ page: name }, '', url);
  }

  if (name === 'discover')     refreshDiscoverIfStale();
  if (name === 'requests')     loadMyRequests();
  if (name === 'all-requests') loadAllRequests();
  if (name === 'downloads')    startDownloadsPolling();
  else                         stopDownloadsPolling();
  if (name === 'mood')         loadForYou();
  if (name === 'users')        loadUsers();
  if (name === 'settings')     { loadConnections(); loadApprovalSettings(); loadLidarrAddSettings(); loadNotificationTargets(); loadRetentionSettings(); }
  if (name === 'api')          loadApiKeys();
}
document.querySelectorAll('.nav-item[data-page]').forEach(n =>
  n.addEventListener('click', () => showPage(n.dataset.page))
);
window.addEventListener('popstate', e => {
  showPage((e.state && e.state.page) || pageFromPath(), { fromHistory: true });
});
function pageFromPath() {
  const seg = resolvePage(location.pathname.replace(/^\/+|\/+$/g, ''));
  return PAGES.includes(seg) ? seg : 'discover';
}

/* ── Boot ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const nameEl = document.getElementById('topbar-username');
  if (nameEl) nameEl.textContent = UNAME || '—';
  // Reveals BOTH the admin nav items and their "Admin" group heading, so a
  // regular user never sees a section header with nothing under it.
  if (ROLE === 'admin') document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  loadQuota();

  const doLogout = () => { localStorage.clear(); window.location.href = '/login.html'; };
  document.getElementById('logout-btn')?.addEventListener('click', doLogout);

  // ── Logo → main (Discover) page ──────────────────────────────────────────
  // Anchors point at "/" so they still work as real links, but when the SPA is
  // already loaded we just switch pages instead of doing a full reload.
  ['sidebar-logo-link', 'topbar-logo-link'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', e => {
      e.preventDefault();
      showPage('discover');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // ── Change password (self-service, all users) ────────────────────────────
  document.getElementById('account-btn')?.addEventListener('click', openChangePassword);
  ['cp-close','cp-cancel'].forEach(id =>
    document.getElementById(id)?.addEventListener('click', () => closeModal('modal-change-password'))
  );
  document.getElementById('cp-submit')?.addEventListener('click', submitChangePassword);
  document.getElementById('modal-change-password')?.addEventListener('click', e => {
    if (e.target.id === 'modal-change-password') closeModal('modal-change-password');
  });
  document.getElementById('modal-change-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); document.getElementById('cp-submit')?.click(); }
  });
  // Generic show/hide toggles inside the change-password modal
  document.querySelectorAll('.pw-toggle[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.target);
      if (!inp) return;
      const reveal = inp.type === 'password';
      inp.type = reveal ? 'text' : 'password';
      const eye = btn.querySelector('.pw-eye'), eyeOff = btn.querySelector('.pw-eye-off');
      if (eye)    eye.style.display    = reveal ? 'none' : '';
      if (eyeOff) eyeOff.style.display = reveal ? ''     : 'none';
      btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    });
  });

  ['modal-request-close','modal-request-cancel'].forEach(id =>
    document.getElementById(id)?.addEventListener('click', () => closeModal('modal-request'))
  );
  ['modal-user-close','modal-user-cancel'].forEach(id =>
    document.getElementById(id)?.addEventListener('click', () => closeModal('modal-add-user'))
  );
  document.getElementById('modal-request')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modal-request')) closeModal('modal-request');
  });

  document.getElementById('search-btn')?.addEventListener('click', () => { hideSearchSuggest(); doSearch(); });
  initSearchSuggest();   // typeahead — also owns the Enter-key behaviour
  document.querySelectorAll('.search-type-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('.search-type-btn').forEach(b => {
        b.classList.remove('active'); b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      const input = document.getElementById('search-input');
      const wrap  = document.getElementById('search-results-wrap');
      // Switching Artists↔Albums used to leave the PREVIOUS type's results on
      // screen — so the grid showed albums while the toggle said Artists. Re-run
      // the search if there's a query, otherwise clear back to the empty state.
      if (input?.value.trim()) {
        hideSearchSuggest();
        doSearch();
      } else if (wrap) {
        _searchSeq++;                       // cancel anything still in flight
        wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>Search for music</h3><p>Artists via Deezer + MusicBrainz · albums via MusicBrainz</p></div>';
      }
    })
  );

  initSlider('artists-track', 'artists-prev', 'artists-next');
  initSlider('alltime-track', 'alltime-prev', 'alltime-next');
  initSlider('albums-track',  'albums-prev',  'albums-next');

  // Per-section source dropdowns (Deezer / iTunes / Last.fm). The choice is
  // saved server-side so it sticks across reloads and other browsers.
  document.querySelectorAll('.source-select[data-section]').forEach(sel =>
    sel.addEventListener('change', () => {
      const section = sel.dataset.section;
      renderDiscoverSection(section);
      savePreferences({ discoverSources: { [section]: sel.value } });
    })
  );

  // Request Approvals (Admin page): the global auto-approve switch saves
  // immediately on change — no separate Save button, like Overseerr.
  document.getElementById('set-auto-approve-all')?.addEventListener('change', saveApprovalSettings);
  // Lidarr add behaviour (Connections card): instant-save on change
  document.getElementById('set-lidarr-monitor')?.addEventListener('change', saveLidarrAddSettings);
  document.getElementById('set-search-on-add')?.addEventListener('change', saveLidarrAddSettings);
  // "For You" (Discover): pick a fresh set of library seeds
  document.getElementById('foryou-shuffle')?.addEventListener('click', shuffleForYou);
  // All-Time: page forward through the curated roster
  document.getElementById('alltime-refresh')?.addEventListener('click', refreshAllTime);
  // New & Trending: manual refresh, and an automatic one when the tab wakes up
  // on a stale page (a PWA is essentially never closed).
  document.getElementById('discover-refresh')?.addEventListener('click', refreshDiscoverNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' &&
        document.getElementById('page-discover')?.classList.contains('active')) {
      refreshDiscoverIfStale();
    }
  });
  // Keep the "Updated N min ago" stamp honest without re-fetching.
  setInterval(renderDiscoverFreshness, 60000);
  // Request counters (All Requests page): tap a tile → filter the table below
  document.getElementById('request-stats')?.addEventListener('click', handleRequestStatsClick);

  // Connections (Admin page): link Lidarr / Last.fm from inside the app
  document.getElementById('conn-save-btn')?.addEventListener('click', saveConnections);
  document.getElementById('conn-test-btn')?.addEventListener('click', testLidarrConnection);
  document.getElementById('conn-clear-lidarr-key')?.addEventListener('click', () => clearSavedKey('lidarr'));
  document.getElementById('conn-clear-lastfm-key')?.addEventListener('click', () => clearSavedKey('lastfm'));

  document.getElementById('generate-key-btn')?.addEventListener('click', generateApiKey);
  document.getElementById('apikeys-wrap')?.addEventListener('click', handleApiKeysClick);

  document.getElementById('modal-request-submit')?.addEventListener('click', submitRequest);
  document.getElementById('add-user-btn')?.addEventListener('click', () => openUserModal());
  document.getElementById('modal-user-submit')?.addEventListener('click', saveUser);
  document.getElementById('users-tbody')?.addEventListener('click', handleUserTableClick);
  document.getElementById('all-requests-wrap')?.addEventListener('click', handleAllRequestsClick);
  document.getElementById('my-requests-wrap')?.addEventListener('click', handleMyRequestsClick);

  // ── All Requests search + filters ────────────────────────────────────────
  let arSearchTimer = null;
  document.getElementById('ar-search')?.addEventListener('input', () => {
    clearTimeout(arSearchTimer);
    arSearchTimer = setTimeout(loadAllRequests, 250);
  });
  document.getElementById('ar-status')?.addEventListener('change', loadAllRequests);
  document.getElementById('ar-type')?.addEventListener('change', loadAllRequests);
  document.getElementById('ar-clear')?.addEventListener('click', () => {
    const s = document.getElementById('ar-search'); if (s) s.value = '';
    const st = document.getElementById('ar-status'); if (st) st.value = '';
    const t = document.getElementById('ar-type');   if (t) t.value = '';
    loadAllRequests();
  });

  // New in 2.10 — Download Activity, notification targets, retention.
  document.getElementById('downloads-wrap')?.addEventListener('click', handleDownloadsClick);
  document.getElementById('downloads-refresh')?.addEventListener('click', loadDownloads);
  document.getElementById('notif-add-btn')?.addEventListener('click', addNotificationTarget);
  document.getElementById('notif-targets-wrap')?.addEventListener('click', handleNotifClick);
  document.getElementById('retention-save')?.addEventListener('click', saveRetentionSettings);
  document.getElementById('backup-download')?.addEventListener('click', () => downloadWithAuth('/api/backup', 'audioseerr-backup.json'));
  document.getElementById('csv-export')?.addEventListener('click', () => downloadWithAuth('/api/requests/export.csv', 'audioseerr-requests.csv'));
  document.getElementById('set-lidarr-root')?.addEventListener('change', saveLidarrAddSettings);
  document.getElementById('set-lidarr-metadata')?.addEventListener('change', saveLidarrAddSettings);

  // Escape closes whichever modal is open, and restores focus. None of the
  // modals had any keyboard dismissal before.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.modal-backdrop:not(.hidden)');
    if (open) { e.preventDefault(); open.classList.add('hidden'); }
  });

  // Show the running version in the sidebar — it was computed server-side and
  // returned by /api/health and /api/summary, but never displayed anywhere.
  fetch('/api/health').then(r => r.json()).then(h => {
    const el = document.getElementById('app-version');
    if (el && h.version) el.textContent = `v${h.version}`;
  }).catch(() => {});

  // Load saved preferences first, apply them to the Discover source dropdowns,
  // THEN fetch discover so the very first render already reflects the user's
  // chosen sources (and notifications use the synced "seen" marker).
  loadPreferences().then(() => {
    applyDiscoverSourcePrefs();
    loadDiscover();
    if (ROLE === 'admin') startRequestNotifications();
  });
  checkLidarrStatus();

  // Honour the URL we were opened with (deep link / refresh / shared link).
  const initial = pageFromPath();
  if (initial !== 'discover') showPage(initial, { fromHistory: true });
});

/* Push saved Discover source choices onto the <select>s. */
function applyDiscoverSourcePrefs() {
  const map = PREFS.discoverSources || {};
  ['artists', 'albums', 'upcoming'].forEach(section => {
    const sel = document.getElementById(`${section}-source`);
    if (sel && map[section] && sel.value !== map[section]) sel.value = map[section];
  });
}

/* ── Modal helpers ──────────────────────────────────────────────────────── */
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }

/* ── Lidarr connection status ─────────────────────────────────────────────
   Rendered in two shapes: a service card in the sidebar footer (name + version
   on two lines, like the *arr dashboards) and a compact dot+label pill in the
   top bar. One fetch feeds both. */
function paintLidarrStatus(state, label, detail) {
  const colour = { ok: '#1db954', down: '#e04343', busy: 'var(--gold)' }[state] || 'var(--text-muted)';

  const card = document.getElementById('lidarr-status-badge');
  if (card) {
    card.classList.toggle('svc-down', state === 'down');
    card.title = detail || '';
    card.innerHTML =
      `<span class="status-dot" style="color:${colour}"></span>` +
      `<span class="svc-body"><span class="svc-name">Lidarr</span>` +
      `<span class="svc-meta">${esc(label)}</span></span>`;
  }

  const pill = document.getElementById('m-lidarr-status-badge');
  if (pill) {
    pill.title = detail || '';
    pill.innerHTML =
      `<span class="status-dot" style="color:${colour}"></span>` +
      `<span class="topbar-status-text">Lidarr${state === 'ok' ? ' ' + esc(label) : ''}</span>`;
  }
}

async function checkLidarrStatus() {
  paintLidarrStatus('busy', 'checking…');
  try {
    const s = await api('/api/lidarr/status');
    // esc(): the version string is whatever the configured Lidarr URL reports,
    // and it lands in innerHTML for every user — treat it as untrusted.
    if (s.connected) paintLidarrStatus('ok', `v${s.version}`, s.reason || '');
    else             paintLidarrStatus('down', 'not connected', s.reason || '');
  } catch (e) {
    paintLidarrStatus('down', 'unavailable', e.message);
  }
}

/* ── Top-bar request quota ────────────────────────────────────────────────
   Identity used to come from localStorage, written once at login — so a role
   change or a spent quota stayed stale until the next sign-in. /api/me is the
   live answer. */
async function loadQuota() {
  const nameEl  = document.getElementById('topbar-username');
  const quotaEl = document.getElementById('topbar-quota');
  try {
    const me = await api('/api/me');
    if (nameEl) nameEl.textContent = me.username || UNAME || '—';
    // Keep the cached role honest too, so admin-only UI follows a demotion.
    if (me.role && me.role !== ROLE) {
      ROLE = me.role;
      localStorage.setItem('as_role', me.role);
      document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', me.role !== 'admin'));
    }
    if (!quotaEl) return;
    if (me.unlimited)        quotaEl.textContent = ' · unlimited requests';
    else if (!me.canRequest) quotaEl.textContent = ' · requests disabled';
    else                     quotaEl.textContent = ` · ${me.requestsToday}/${me.requestLimit} requests today`;
  } catch { /* transient — leave whatever is shown */ }
}

/* ── Item store ───────────────────────────────────────────────────────────
   Tiles are re-rendered constantly (source switches, shuffles, every search),
   and each render minted new keys while the old entries stayed forever — an
   unbounded leak over a long session. Bounded FIFO: entries far older than the
   tiles currently on screen can't be referenced any more. */
window.__itemStore = new Map();
const ITEM_STORE_MAX = 800;
function storeItem(item) {
  const k = 'k' + Math.random().toString(36).slice(2, 10);
  window.__itemStore.set(k, item);
  while (window.__itemStore.size > ITEM_STORE_MAX) {
    window.__itemStore.delete(window.__itemStore.keys().next().value);
  }
  return k;
}
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-item-key]');
  if (!btn) return;
  const item = window.__itemStore.get(btn.dataset.itemKey);
  if (!item) { toast('Could not load item data', 'error'); return; }
  // The in-library badge is an ARTIST-level fact. Blocking album tiles on it
  // made the most common request in the app impossible: "I already have this
  // artist, now get me this other album of theirs". Only artist requests are
  // blocked; album tiles open the modal and the server monitors the album.
  if (btn.dataset.inLibrary === '1' && item.type !== 'album') {
    const label = item.title || item.name || item.artist || 'This';
    toast(`📚 "${label}" is already in your Lidarr library`, 'info');
    return;
  }
  openRequestModal(item);
});

/* ══════════════════════════════════════════════════════════════════════════
   REQUEST MODAL
   ══════════════════════════════════════════════════════════════════════════ */
let currentRequestItem      = null;
let selectedQualityProfileId = null;
let selectedQualityName      = null;
let selectedForeignArtistId  = null;
let selectedForeignAlbumId   = null;

function openRequestModal(item) {
  currentRequestItem       = item;
  selectedForeignArtistId  = null;
  selectedForeignAlbumId   = null;
  selectedQualityProfileId = null;
  selectedQualityName      = null;

  const cover = item.cover || item.image || '';
  // The modal is reused, so un-hide it: a previous item with a broken cover
  // would otherwise leave it display:none for every item after it.
  const coverEl = document.getElementById('modal-cover');
  coverEl.style.display = cover ? '' : 'none';
  coverEl.src                                             = cover || '';
  document.getElementById('modal-item-title').textContent = item.title  || item.name  || '—';
  document.getElementById('modal-item-sub').textContent   = item.artist || item.artistName || '';
  document.getElementById('modal-item-type').textContent  = `Type: ${item.type || (item.albumName ? 'album' : 'artist')}`;

  const msgEl = document.getElementById('lidarr-check-msg');
  if (msgEl) { msgEl.classList.add('hidden'); msgEl.textContent = ''; msgEl.removeAttribute('style'); }

  const btn = document.getElementById('modal-request-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; btn.style.cssText = ''; }

  // Clear match wrap while loading
  const matchWrap = document.getElementById('lidarr-match-wrap');
  if (matchWrap) matchWrap.innerHTML = '';

  openModal('modal-request');

  const type = item.type || (item.albumName ? 'album' : 'artist');
  const q    = (type === 'album'
    ? (item.albumName || item.title)
    : (item.name || item.artistName || item.artist)
  ) || '';

  // Artist-level duplicate check. Only meaningful for ARTIST requests: for an
  // album request, owning the artist is expected and is not a reason to refuse.
  const artistForCheck = (item.artist || item.artistName || item.name || '').trim();
  const inLibPromise = (type !== 'album' && artistForCheck)
    ? api(`/api/lidarr/in-library?artistName=${encodeURIComponent(artistForCheck)}&deep=1`).catch(() => ({ inLibrary: false }))
    : Promise.resolve({ inLibrary: false });

  Promise.all([
    loadQualityProfiles(),
    loadLidarrMatches(type, q),
    inLibPromise
  ]).then(([, , inLib]) => {
    if (inLib && inLib.inLibrary) {
      // Already in library — don't let them re-request. Close + popup.
      closeModal('modal-request');
      const label = item.title || item.name || item.artist || artistForCheck || 'This';
      toast(`📚 "${label}" is already in your Lidarr library`, 'info');
      return;
    }
    refreshSubmitState();   // respects an in-library flag on the selected match
  });
}

/* Load quality profiles from Lidarr */
async function loadQualityProfiles() {
  const grid = document.getElementById('quality-grid');
  if (!grid) return;
  grid.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px 0">Loading from Lidarr…</div>';
  try {
    const cfg = await api('/api/lidarr/profiles');
    if (!cfg.qualityProfiles?.length) throw new Error('No profiles returned');

    // Default to a profile called "Standard" when Lidarr has one; otherwise
    // fall back to the first profile returned. Match is case-insensitive.
    const profiles    = cfg.qualityProfiles;
    let defaultIdx    = profiles.findIndex(q => (q.name || '').trim().toLowerCase() === 'standard');
    if (defaultIdx === -1) defaultIdx = 0;

    // role=radio + tabindex: these were plain <div>s with a click listener and
    // no tabindex, so a keyboard user could not change the quality profile at
    // all, and a screen reader saw no selection state.
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Quality profile');
    grid.innerHTML = profiles.map((q, i) =>
      `<div class="quality-opt${i === defaultIdx ? ' selected' : ''}" data-qid="${q.id}" data-qname="${esc(q.name)}"
            role="radio" tabindex="0" aria-checked="${i === defaultIdx}">${esc(q.name)}</div>`
    ).join('');
    const chosen = profiles[defaultIdx];
    selectedQualityProfileId = chosen.id;
    selectedQualityName      = chosen.name;
    grid.querySelectorAll('.quality-opt').forEach(opt => {
      const select = () => {
        grid.querySelectorAll('.quality-opt').forEach(o => {
          o.classList.remove('selected'); o.setAttribute('aria-checked', 'false');
        });
        opt.classList.add('selected');
        opt.setAttribute('aria-checked', 'true');
        selectedQualityProfileId = parseInt(opt.dataset.qid) || null;
        selectedQualityName      = opt.dataset.qname;
      };
      opt.addEventListener('click', select);
      opt.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
      });
    });
  } catch(e) {
    grid.innerHTML = '<div style="color:var(--text-muted);font-size:0.78rem">⚠️ Could not load profiles — is Lidarr configured?</div>';
    console.warn('[Quality]', e.message);
  }
}

/* Load Lidarr artist/album matches — user picks the correct one */
async function loadLidarrMatches(type, q) {
  const wrap = document.getElementById('lidarr-match-wrap');
  if (!wrap || !q) return;
  wrap.innerHTML = `<div style="color:var(--text-muted);font-size:0.78rem;padding:6px 0">🔍 Searching Lidarr for "<strong>${esc(q)}</strong>"…</div>`;
  try {
    const endpoint = type === 'album'
      ? `/api/lidarr/search-album?q=${encodeURIComponent(q)}`
      : `/api/lidarr/search-artist?q=${encodeURIComponent(q)}`;
    const results = await api(endpoint);
    if (!results.length) {
      wrap.innerHTML = `<div style="color:var(--gold);font-size:0.78rem;padding:6px 0">⚠️ No Lidarr matches for "<strong>${esc(q)}</strong>" — it will be requested by name</div>`;
      return;
    }
    wrap.innerHTML = `
      <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:6px">
        Select the correct ${type === 'album' ? 'album' : 'artist'} from Lidarr:
      </div>
      <div class="lidarr-match-list">
        ${results.map((r, i) => {
          const imgUrl = type === 'album'
            ? (r.images?.find(x => x.coverType === 'cover')?.url || '')
            : (r.images?.find(x => x.coverType === 'poster')?.url || '');
          const title  = type === 'album' ? r.title : r.artistName;
          const sub    = type === 'album' ? (r.artist?.artistName || '') : (r.genres?.slice(0,2).join(', ') || '');
          const fid    = type === 'album' ? r.foreignAlbumId : r.foreignArtistId;
          return `<div class="lidarr-match-item${i === 0 ? ' selected' : ''}"
                    data-fid="${esc(fid)}"
                    data-type="${type}"
                    role="radio" aria-checked="${i === 0}"
                    tabindex="0">
            ${imgUrl
              ? `<img src="${esc(imgUrl)}" class="lm-img" loading="lazy" data-hide-on-error alt="">`
              : `<div class="lm-img lm-img-placeholder"></div>`}
            <div class="lm-body">
              <div class="lm-title">${esc(title)}</div>
              ${sub ? `<div class="lm-sub">${esc(sub)}</div>` : ''}
            </div>
            <div class="lm-check">✓</div>
          </div>`;
        }).join('')}
      </div>`;

    /* Set first as default selection */
    const first = results[0];
    if (type === 'album') {
      selectedForeignAlbumId  = first.foreignAlbumId;
      selectedForeignArtistId = first.artist?.foreignArtistId || null;
    } else {
      selectedForeignArtistId = first.foreignArtistId;
    }

    /* Click handlers */
    wrap.querySelectorAll('.lidarr-match-item').forEach((el, idx) => {
      const select = () => {
        wrap.querySelectorAll('.lidarr-match-item').forEach(x => {
          x.classList.remove('selected'); x.setAttribute('aria-checked', 'false');
        });
        el.classList.add('selected');
        el.setAttribute('aria-checked', 'true');
        if (el.dataset.type === 'album') {
          selectedForeignAlbumId  = el.dataset.fid;
          // Keep the artist id from the matching result so the server can add a
          // brand-new artist alongside the album without a second lookup.
          selectedForeignArtistId = results[idx]?.artist?.foreignArtistId || null;
        } else {
          selectedForeignArtistId = el.dataset.fid;
          selectedForeignAlbumId  = null;
        }
        refreshSubmitState();
      };
      el.addEventListener('click', select);
      // These rows carried tabindex="0" but had no key handler, so focus landed
      // on something that could not be activated.
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
      });
    });

    /* Flag matches whose ARTIST is already in the Lidarr library — by
       foreignArtistId, which is exact and immune to name-spelling differences
       (Deezer "P!nk" vs Lidarr "Pink" etc). Album matches are checked via
       their artist, since album requests are added artist-level anyway.
       Selecting a flagged match disables the submit button, so a duplicate
       can't be sent even when the name-based checks missed it. */
    try {
      const artistFidOf = r => (type === 'album' ? (r.artist?.foreignArtistId || '') : (r.foreignArtistId || ''));
      const fids = [...new Set(results.map(artistFidOf).filter(Boolean))];
      if (fids.length) {
        const chk   = await api('/api/lidarr/in-library-batch', { method: 'POST', body: JSON.stringify({ ids: fids }) });
        const idMap = chk.idResults || {};
        wrap.querySelectorAll('.lidarr-match-item').forEach((el, i) => {
          const fid = artistFidOf(results[i] || {});
          if (fid && idMap[fid]) {
            el.dataset.inLib = '1';
            el.classList.add('in-library');
            el.querySelector('.lm-body')?.insertAdjacentHTML('beforeend', '<div class="lm-inlib">📚 Already in library</div>');
          }
        });
        refreshSubmitState();
      }
    } catch { /* best-effort — server still refuses duplicates on submit */ }
  } catch(e) {
    wrap.innerHTML = '<div style="color:var(--text-muted);font-size:0.78rem;padding:6px 0">⚠️ Lidarr search unavailable</div>';
    console.warn('[LidarrMatch]', e.message);
  }
}

/* Enable/disable the modal submit button based on whether the currently
   selected Lidarr match is already in the library. Called after the picker
   renders, after its in-library flags land, whenever the selection changes,
   and when the modal's initial checks finish — always reads live DOM state,
   so call order between those doesn't matter. */
function refreshSubmitState() {
  const btn = document.getElementById('modal-request-submit');
  if (!btn) return;
  const isAlbum = (currentRequestItem?.type === 'album') || Boolean(currentRequestItem?.albumName);
  const sel     = document.querySelector('#lidarr-match-wrap .lidarr-match-item.selected');
  // Only an ARTIST request is blocked by the artist already being present —
  // for an album request that is the normal case, and the server will monitor
  // the specific album under the existing artist.
  const blocked = !isAlbum && sel?.dataset.inLib === '1';
  btn.disabled    = blocked;
  btn.textContent = blocked ? '📚 Already in library'
                  : (isAlbum ? 'Add album to Lidarr' : 'Send to Lidarr');
}

/* Submit request */
async function submitRequest() {
  if (!currentRequestItem) { toast('No item selected', 'error'); return; }
  const item       = currentRequestItem;
  const type       = item.type || (item.albumName ? 'album' : 'artist');
  const artistName = (item.artist || item.name || item.artistName || '').trim();
  const albumName  = type === 'album' ? (item.albumName || item.title || '').trim() : null;
  if (!artistName && !albumName) { toast('Missing artist or album name', 'error'); return; }

  const payload = {
    type, artistName,
    albumName:        albumName || null,
    cover:            item.cover || item.image || null,
    mbid:             item.mbid  || null,
    qualityProfileId: selectedQualityProfileId,
    qualityName:      selectedQualityName || 'Default',
    year:             item.year  || null,
    foreignArtistId:  selectedForeignArtistId || null,
    foreignAlbumId:   selectedForeignAlbumId  || null
  };

  const btn   = document.getElementById('modal-request-submit');
  const msgEl = document.getElementById('lidarr-check-msg');
  if (btn)   { btn.disabled = true; btn.textContent = '⏳️ Sending…'; }
  if (msgEl) {
    msgEl.textContent = 'Sending to Lidarr…';
    msgEl.style.cssText = 'background:rgba(245,166,35,0.08);border-left:3px solid var(--gold);color:var(--gold);padding:8px 12px;border-radius:4px;margin-top:8px;font-size:0.82rem;';
    msgEl.classList.remove('hidden');
  }

  try {
    const result = await api('/api/requests', { method:'POST', body: JSON.stringify(payload) });
    closeModal('modal-request');
    loadQuota();                       // the counter in the top bar just moved
    const label  = albumName || artistName;
    const status = result.lidarrStatus || result.status || '';
    // The library just changed — drop this artist from the session cache and
    // re-run badging so Discover, Search, Mood, and the library-seeded "For
    // You" rows reflect the new state immediately (all their tiles carry
    // data-artist). For You needs its own call: its rows are cached for 30
    // min server-side, so a just-requested artist stays on screen and must
    // visibly flip to "In Library" instead of offering Request again.
    if (status === 'sent' || status === 'exists') {
      if (artistName) delete _libStatusCache[artistName.toLowerCase()];
      flagDiscoverInLibrary();
      const searchWrap = document.getElementById('search-results-wrap');
      const moodWrap   = document.getElementById('mood-results');
      const foryouWrap = document.getElementById('foryou-wrap');
      if (searchWrap) flagDiscoverInLibrary(searchWrap);
      if (moodWrap)   flagDiscoverInLibrary(moodWrap);
      if (foryouWrap) flagDiscoverInLibrary(foryouWrap);
    }
    // Report what actually happened. An album request now genuinely monitors
    // that album (result.lidarrType === 'album'); when it falls back to an
    // artist add, say so rather than claiming the album was sent.
    if (status === 'sent') {
      if (albumName && result.lidarrType === 'album')      toast(`✅️ "${albumName}" is now monitored in Lidarr [${result.quality}]`, 'success');
      else if (albumName)                                  toast(`✅️ "${artistName}" added to Lidarr (requested album: "${albumName}") [${result.quality}]`, 'success');
      else                                                 toast(`✅️ "${label}" sent to Lidarr [${result.quality}]`, 'success');
    }
    else if (status === 'pending' && result.approvalStatus === 'pending' && /failed/i.test(result.lidarrMessage || ''))
                                          toast(`⚠️ "${label}" saved, but Lidarr rejected it — an admin can retry from All Requests`, 'warning');
    else if (status === 'pending')         toast(`🕓 "${label}" requested — waiting for admin approval`, 'info');
    else if (status === 'exists')          toast(`📚 "${label}" is already in your Lidarr library`, 'info');
    else if (status === 'not_found')       toast(`⚠️ "${label}" was saved but Lidarr couldn't find a match — check your search`, 'warning');
    else if (status === 'error')           toast(`❌ Lidarr error: ${result.lidarrMessage}`, 'error');
    else if (status === 'not_configured')  toast('🔌 Lidarr not linked — add it in Admin → Connections', 'warning');
    else                                   toast(`✅️ "${label}" sent to Lidarr`, 'success');
  } catch(e) {
    if (msgEl) {
      msgEl.textContent = `❌ ${e.message}`;   // textContent — escaping here would show entities
      msgEl.style.cssText = 'background:rgba(224,67,67,0.08);border-left:3px solid #e04343;color:#e04343;padding:8px 12px;border-radius:4px;margin-top:8px;font-size:0.82rem;';
    }
    toast('❌ ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Send to Lidarr'; }
  }
}

/* ── Helpers ────────────────────────────────────────────────────────────── */
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fallback(name) {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name||'?')}&size=300&background=111827&color=f5a623&bold=true&format=svg`;
}

/* Image fallback, handled by ONE delegated listener instead of an inline
   onerror per tile.
   The old form was  onerror="this.src='${fallback(name)}'"  — an unescaped URL
   spliced into a JS string literal inside an HTML attribute. encodeURIComponent
   deliberately does NOT escape the apostrophe (it is an RFC 3986 unreserved
   mark), so an artist or album name containing one — and plenty do — closed the
   string and the rest of the name was parsed as JavaScript. Names come straight
   from MusicBrainz/Last.fm/Deezer, and the CSP allows 'unsafe-inline' scripts,
   so that was directly executable. HTML-escaping alone would NOT have fixed it:
   the parser entity-decodes the attribute before the handler is compiled.
   Using a data- attribute keeps the value in data space, where esc() is
   sufficient and correct. */
document.addEventListener('error', e => {
  const t = e.target;
  if (!t || t.tagName !== 'IMG') return;
  if (t.dataset.fallback && t.src !== t.dataset.fallback) { t.src = t.dataset.fallback; return; }
  // Covers were hidden with an inline onerror, which helmet's CSP blocks
  // outright (script-src-attr 'none'), so a missing cover rendered as the
  // browser's broken-image icon instead of disappearing.
  if (t.dataset.hideOnError !== undefined) t.style.display = 'none';
}, true);   // capture: 'error' on <img> does not bubble

/* ── Tile renderers ─────────────────────────────────────────────────────── */
function artistTileHTML(a) {
  const name = a.name || 'Unknown Artist';
  const img  = a.image || fallback(name);
  const k    = storeItem({ type:'artist', name, artist:name, image:img, mbid:a.mbid||null });
  return `<div class="music-tile slider-item" data-artist="${esc(name)}">
    <div class="tile-img-wrap">
      <img class="tile-img" src="${esc(img)}" alt="${esc(name)}" loading="lazy" data-fallback="${esc(fallback(name))}">
      <div class="tile-overlay">
        <div class="overlay-title">${esc(name)}</div>
        <div class="overlay-actions"><button class="btn btn-primary btn-sm" data-item-key="${k}">+ Request</button></div>
      </div>
      <span class="tile-source-badge">${esc(a.source||'')}</span>
    </div>
    <div class="tile-body">
      <div class="tile-name">${esc(name)}</div>
      <div class="tile-footer"><button class="btn btn-ghost btn-sm" data-item-key="${k}">Request</button></div>
    </div>
  </div>`;
}

function albumTileHTML(a) {
  const title  = a.title  || 'Unknown Album';
  const artist = a.artist || 'Unknown Artist';
  const img    = a.cover  || fallback(title);
  const k      = storeItem({ type:'album', title, albumName:title, artist, artistName:artist, cover:img, mbid:a.mbid||null, year:a.year||null });
  return `<div class="music-tile slider-item" data-artist="${esc(artist)}">
    <div class="tile-img-wrap">
      <img class="tile-img" src="${esc(img)}" alt="${esc(title)}" loading="lazy" data-fallback="${esc(fallback(title))}">
      <div class="tile-overlay">
        <div class="overlay-title">${esc(title)}</div>
        <div class="overlay-artist">${esc(artist)}</div>
        <div class="overlay-actions"><button class="btn btn-primary btn-sm" data-item-key="${k}">+ Request</button></div>
      </div>
      <span class="tile-source-badge">${esc(a.source||'')}</span>
      ${a.upcoming ? `<span class="tile-upcoming" title="Released ${esc(a.releaseDate||'')}">Upcoming</span>` : ''}
    </div>
    <div class="tile-body">
      <div class="tile-name">${esc(title)}</div>
      <div class="tile-sub">${esc(artist)}${a.upcoming && a.releaseDate ? ` · out ${esc(a.releaseDate)}` : ''}</div>
      <div class="tile-footer"><button class="btn btn-ghost btn-sm" data-item-key="${k}">Request</button></div>
    </div>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   DISCOVER — each section (artists / albums / new & upcoming) has its own
   source dropdown (Deezer · iTunes · Last.fm). All three services are fetched
   once via the server proxy, cached, then each section renders from whichever
   service its dropdown is set to.
   ══════════════════════════════════════════════════════════════════════════ */
const SOURCE_LABEL = { deezer:'Deezer', itunes:'iTunes', lastfm:'Last.fm' };

/* Raw payloads, kept so switching a dropdown is instant (no refetch). */
let DISCOVER = { deezer:{ artists:[], albums:[], tracks:[] }, itunes:{ results:[] }, itunesNew:{ results:[] }, lfm:{ artists:[], tracks:[] }, alltime:[] };

/* De-dupe helper keyed on a string. */
function dedupe(items, keyFn) {
  const seen = new Set(); const out = [];
  for (const it of items) {
    const k = (keyFn(it) || '').toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(it);
  }
  return out;
}

/* ── Per-source builders ────────────────────────────────────────────────── */
function artistsFrom(source) {
  if (source === 'deezer') {
    return dedupe((DISCOVER.deezer.artists||[]).map(a => ({
      name: a.name,
      image: a.picture_xl || a.picture_big || a.picture_medium || null,
      source: 'Deezer'
    })), a => a.name);
  }
  if (source === 'lastfm') {
    // server already flattens Last.fm images to a string (or null)
    return dedupe((DISCOVER.lfm.artists||[]).filter(a => a.name).map(a => ({
      name: a.name, image: a.image || null, source: 'Last.fm'
    })), a => a.name);
  }
  if (source === 'itunes') {
    // iTunes feed is albums; derive a unique-artist list from it
    return dedupe((DISCOVER.itunes.results||[]).filter(e => e.artistName).map(e => ({
      name: e.artistName,
      image: e.artworkUrl100?.replace('100x100bb','600x600bb') || null,
      source: 'iTunes'
    })), a => a.name);
  }
  return [];
}

function albumsFrom(source) {
  if (source === 'deezer') {
    return dedupe((DISCOVER.deezer.albums||[]).map(a => ({
      title: a.title, artist: a.artist?.name || '',
      cover: a.cover_xl || a.cover_big || a.cover_medium || null,
      source: 'Deezer'
    })), a => a.title + '|' + a.artist);
  }
  if (source === 'itunes') {
    return dedupe((DISCOVER.itunes.results||[]).filter(e => e.name).map(e => ({
      title: e.name, artist: e.artistName || '',
      cover: e.artworkUrl100?.replace('100x100bb','600x600bb') || null,
      year: e.releaseDate?.slice(0,4) || null, source: 'iTunes'
    })), a => a.title + '|' + a.artist);
  }
  if (source === 'lastfm') {
    // Last.fm chart has no albums endpoint → use top tracks as album-style tiles
    return dedupe((DISCOVER.lfm.tracks||[]).filter(t => t.title).map(t => ({
      title: t.title, artist: t.artist?.name || t.artist || '',
      cover: t.cover || null, source: 'Last.fm'
    })), a => a.title + '|' + a.artist);
  }
  return [];
}

function upcomingFrom(source) {
  if (source === 'deezer') {
    return dedupe((DISCOVER.deezer.tracks||[]).filter(t => t.album?.title).map(t => ({
      title: t.album.title, artist: t.artist?.name || '',
      cover: t.album.cover_xl || t.album.cover_big || t.album.cover_medium || null,
      source: 'Deezer'
    })), a => a.title + '|' + a.artist);
  }
  if (source === 'itunes') {
    // Served by the server already sorted newest-first (Apple has no dedicated
    // new-releases feed any more, so this is the top-albums chart re-sorted by
    // release date). Entries dated in the future are flagged `upcoming`.
    return dedupe((DISCOVER.itunesNew.results||[]).filter(e => e.name).map(e => ({
      title: e.name, artist: e.artistName || '',
      cover: e.artworkUrl100?.replace('100x100bb','600x600bb') || null,
      year: e.releaseDate?.slice(0,4) || null,
      releaseDate: e.releaseDate || null,
      upcoming: Boolean(e.upcoming),
      source: 'iTunes'
    })), a => a.title + '|' + a.artist);
  }
  if (source === 'lastfm') {
    return dedupe((DISCOVER.lfm.tracks||[]).filter(t => t.title).map(t => ({
      title: t.title, artist: t.artist?.name || t.artist || '',
      cover: t.cover || null, source: 'Last.fm'
    })), a => a.title + '|' + a.artist);
  }
  return [];
}

/* ── Render a single section from its current dropdown value ─────────────── */
function renderDiscoverSection(section) {
  const sel    = document.getElementById(`${section}-source`);
  const source = sel?.value || 'deezer';
  const label  = SOURCE_LABEL[source] || source;
  const none   = (what) => `<p style="color:var(--text-muted);padding:20px 0">No ${what} from ${label} right now</p>`;

  if (section === 'artists') {
    const items = artistsFrom(source);
    document.getElementById('artists-track').innerHTML =
      items.length ? items.slice(0,20).map(artistTileHTML).join('') : none('trending artists');
    resetSlider('artists-track');
    flagDiscoverInLibrary(document.getElementById('artists-track'));
  } else if (section === 'albums') {
    const items = albumsFrom(source);
    document.getElementById('albums-track').innerHTML =
      items.length ? items.slice(0,20).map(albumTileHTML).join('') : none('trending albums');
    resetSlider('albums-track');
    flagDiscoverInLibrary(document.getElementById('albums-track'));
  } else if (section === 'upcoming') {
    const items = upcomingFrom(source);
    document.getElementById('upcoming-grid').innerHTML =
      items.length ? items.slice(0,24).map(albumTileHTML).join('') : none('releases');
    flagDiscoverInLibrary(document.getElementById('upcoming-grid'));
  }
}

/* The curated all-time roster is far longer than one screenful, so it is served
   a page at a time and ↻ Refresh walks forward through it (wrapping at the
   end). Artwork is memoised per artist server-side, so paging is cheap. */
let ALLTIME_PAGE = 0, ALLTIME_PAGES = 1;

function renderAllTime() {
  const track = document.getElementById('alltime-track');
  if (!track) return;
  const items = DISCOVER.alltime || [];
  track.innerHTML = items.length
    ? items.map(artistTileHTML).join('')
    : `<p style="color:var(--text-muted);padding:20px 0">No all-time artists right now</p>`;
  const label = document.getElementById('alltime-page');
  if (label) label.textContent = ALLTIME_PAGES > 1 ? `${ALLTIME_PAGE + 1} / ${ALLTIME_PAGES}` : '';
  resetSlider('alltime-track');
  flagDiscoverInLibrary(track);      // badge any of these you already own
}

async function refreshAllTime() {
  const btn = document.getElementById('alltime-refresh');
  if (btn) { btn.disabled = true; btn.textContent = '⏳️ Loading…'; }
  try {
    const next = (ALLTIME_PAGE + 1) % Math.max(1, ALLTIME_PAGES);
    const r = await api(`/api/discover/alltime?page=${next}`);
    DISCOVER.alltime = r.artists || [];
    ALLTIME_PAGE  = r.page ?? next;
    ALLTIME_PAGES = r.pages ?? 1;
    renderAllTime();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻️ Refresh'; }
  }
}

function renderAllDiscoverSections() {
  ['artists','albums','upcoming'].forEach(renderDiscoverSection);
  renderAllTime();
  // Once everything is on the page, badge any tile whose artist is already in
  // the Lidarr library so people don't re-request what they already have.
  flagDiscoverInLibrary();
}

/* ── "For You" — library-seeded recommendation rows (Mood Discovery page) ──
   Auto-populates the Mood Discovery page with "Because you have <seed>" rows
   the moment it opens, so there's something personal to browse before typing
   a single search. The server picks random artists from the Lidarr library
   and returns similar artists (library items already filtered out). Tiles
   reuse artistTileHTML, so requesting and in-library badging work exactly
   like everywhere else. Hidden when there's nothing to show (Lidarr not
   linked, empty library, or upstream sources down). */
let FORYOU = { rows: [] };
let _forYouFetchedAt = 0;

// The server tells us WHY there are no rows (not_configured / library_empty /
// library_unavailable). That was being thrown away, so an unlinked Lidarr and a
// transient outage both showed the same silent nothing.
const FORYOU_REASON = {
  not_configured:      'Link Lidarr in Admin → Connections to get picks based on your own library.',
  library_empty:       'Your Lidarr library is empty — add a few artists and personal picks will appear here.',
  library_unavailable: 'Could not reach Lidarr just now, so there are no personal picks yet.'
};
let FORYOU_LAST_REASON = null;

async function loadForYou(force) {
  const wrap = document.getElementById('foryou-wrap');
  if (!wrap) return;
  // The server caches the assembled rows for 30 min, so refetching is cheap —
  // but skip even the round-trip when we fetched moments ago.
  if (!force && FORYOU.rows.length && Date.now() - _forYouFetchedAt < 5 * 60 * 1000) return;
  try {
    const r = await api('/api/discover/for-you');
    FORYOU = { rows: r.rows || [] };
    FORYOU_LAST_REASON = r.reason || null;
    _forYouFetchedAt = Date.now();
    renderForYou();
  } catch { /* leave whatever is currently rendered */ }
}

function renderForYou() {
  const wrap   = document.getElementById('foryou-wrap');
  const rowsEl = document.getElementById('foryou-rows');
  if (!wrap || !rowsEl) return;
  const rows = FORYOU.rows || [];
  if (!rows.length) {
    // Explain the absence instead of silently hiding the whole section.
    const why = FORYOU_REASON[FORYOU_LAST_REASON];
    if (why) {
      rowsEl.innerHTML = `<div class="conn-hint" style="padding:8px 0">${esc(why)}</div>`;
      wrap.classList.remove('hidden');
    } else {
      wrap.classList.add('hidden');
      rowsEl.innerHTML = '';
    }
    return;
  }
  rowsEl.innerHTML = rows.map((r, i) => `
    <div class="foryou-row">
      <div class="slider-header">
        <div class="slider-title foryou-seed">Because you have <span class="foryou-seed-name">${esc(r.seed)}</span></div>
        <div class="slider-controls">
          <button class="slider-btn" id="fy-prev-${i}" aria-label="Scroll back">‹</button>
          <button class="slider-btn" id="fy-next-${i}" aria-label="Scroll forward">›</button>
        </div>
      </div>
      <div class="slider-track-outer">
        <div class="slider-track" id="fy-track-${i}">${r.items.map(artistTileHTML).join('')}</div>
      </div>
    </div>`).join('');
  rows.forEach((_, i) => initSlider(`fy-track-${i}`, `fy-prev-${i}`, `fy-next-${i}`));
  wrap.classList.remove('hidden');
  flagDiscoverInLibrary(wrap);
}

async function shuffleForYou() {
  const btn = document.getElementById('foryou-shuffle');
  if (btn) { btn.disabled = true; btn.textContent = '⏳️ Shuffling…'; }
  try {
    const r = await api('/api/discover/for-you?shuffle=1');
    FORYOU = { rows: r.rows || [] };
    FORYOU_LAST_REASON = r.reason || null;
    _forYouFetchedAt = Date.now();
    renderForYou();
    // Don't blame a transient hiccup when the real cause is configuration.
    if (!(r.rows || []).length) {
      toast(FORYOU_REASON[r.reason] || 'No recommendations right now — try again in a moment', 'info');
    }
  } catch (e) { toast(e.message, 'error'); }
  if (btn) { btn.disabled = false; btn.textContent = '↻️ Shuffle'; }
}

/* ── Freshness ────────────────────────────────────────────────────────────
   These are live charts, but the page used to fetch them exactly once, at boot.
   Leave the tab open overnight (or use the installed PWA, which is never really
   closed) and you were reading yesterday's charts with no way to tell and no
   way to update short of a hard reload.

   Now: a manual ↻ Refresh that bypasses the server cache, plus an automatic
   re-fetch when the page is revisited or the tab regains focus and the data has
   gone stale. The server's own 10-minute cache means a revisit usually costs
   nothing upstream. */
const DISCOVER_STALE_MS = 10 * 60 * 1000;
let _discoverFetchedAt = 0;
let _discoverLoading   = false;

function renderDiscoverFreshness() {
  const el = document.getElementById('discover-freshness');
  if (!el) return;
  if (!_discoverFetchedAt) { el.textContent = ''; return; }
  const mins = Math.round((Date.now() - _discoverFetchedAt) / 60000);
  el.textContent = mins < 1 ? 'Updated just now'
                 : mins < 60 ? `Updated ${mins} min ago`
                 : `Updated ${new Date(_discoverFetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function refreshDiscoverIfStale() {
  if (_discoverLoading) return;
  if (Date.now() - _discoverFetchedAt < DISCOVER_STALE_MS) { renderDiscoverFreshness(); return; }
  loadDiscover({ quiet: true });        // keep current tiles on screen while reloading
}

async function refreshDiscoverNow() {
  const btn = document.getElementById('discover-refresh');
  if (btn) { btn.disabled = true; btn.textContent = '⏳️ Refreshing…'; }
  try { await loadDiscover({ quiet: true, fresh: true }); toast('🔄 Charts updated'); }
  catch (e) { toast(e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '↻️ Refresh'; } }
}

async function loadDiscover(opts = {}) {
  if (_discoverLoading) return;
  _discoverLoading = true;
  // quiet: a background refresh must not blank the page the user is reading.
  const showSpinner = !opts.quiet || !_discoverFetchedAt;
  if (showSpinner) {
    document.getElementById('discover-loading').classList.remove('hidden');
    document.getElementById('discover-content').classList.add('hidden');
  }
  const q = opts.fresh ? '?fresh=1' : '';
  try {
    /* All sources via server proxy — no browser CORS issues */
    const [deezer, itunes, itunesNew, lfm, alltime] = await Promise.all([
      api('/api/discover/deezer' + q).catch(() => ({ artists:[], albums:[], tracks:[] })),
      api('/api/discover/itunes' + q).catch(() => ({ results:[] })),
      api('/api/discover/itunes-new' + q).catch(() => ({ results:[] })),
      api('/api/discover/lastfm' + q).catch(() => ({ artists:[], tracks:[] })),
      api(`/api/discover/alltime?page=${ALLTIME_PAGE}`).catch(() => ({ artists:[] }))
    ]);
    DISCOVER = {
      deezer:    { artists: deezer.artists||[], albums: deezer.albums||[], tracks: deezer.tracks||[] },
      itunes:    { results: itunes.results||[] },
      itunesNew: { results: itunesNew.results||[] },
      lfm:       { artists: lfm.artists||[],    tracks: lfm.tracks||[] },
      alltime:   alltime.artists || []
    };
    ALLTIME_PAGE  = alltime.page  ?? 0;
    ALLTIME_PAGES = alltime.pages ?? 1;

    console.log('[Discover]',
      'Deezer artists=', DISCOVER.deezer.artists.length,
      'albums=', DISCOVER.deezer.albums.length,
      'tracks=', DISCOVER.deezer.tracks.length,
      '| iTunes=', DISCOVER.itunes.results.length,
      '| Last.fm artists=', DISCOVER.lfm.artists.length,
      'tracks=', DISCOVER.lfm.tracks.length
    );

    renderAllDiscoverSections();
    _discoverFetchedAt = Date.now();
    renderDiscoverFreshness();

    document.getElementById('discover-loading').classList.add('hidden');
    document.getElementById('discover-content').classList.remove('hidden');
  } catch(e) {
    console.error('[loadDiscover]', e);
    // A failed background refresh must not wipe the charts already on screen.
    if (showSpinner) {
      document.getElementById('discover-loading').innerHTML =
        `<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Could not load charts</h3><p>${esc(e.message)}</p></div>`;
    } else {
      toast(`Could not refresh charts: ${e.message}`, 'error');
      document.getElementById('discover-content').classList.remove('hidden');
    }
  } finally {
    _discoverLoading = false;
  }
}

/* ── Slider ───────────────────────────────────────────────────────────────
   Measured, not hardcoded. The old version stepped by a fixed 191px against a
   real tile pitch of 187px (175px tile + 12px gap), so every step drifted, and
   it clamped the maximum offset to children.length - 1 instead of
   children.length - visibleCount — which let the track scroll until a single
   tile sat beside seven tile-widths of empty space. Nothing recomputed on
   resize either. */
function initSlider(trackId, prevId, nextId) {
  const track = document.getElementById(trackId);
  if (!track) return;
  let offset = 0;

  const metrics = () => {
    const first = track.children[0];
    const gap   = parseFloat(getComputedStyle(track).columnGap || getComputedStyle(track).gap) || 12;
    const w     = first ? first.getBoundingClientRect().width + gap : 187;
    const outer = track.parentElement?.clientWidth || w;
    return { w, visible: Math.max(1, Math.floor(outer / w)) };
  };
  const upd = () => {
    const { w, visible } = metrics();
    const max = Math.max(0, track.children.length - visible);
    offset = Math.min(offset, max);
    track.style.transform = `translateX(-${offset * w}px)`;
  };

  document.getElementById(prevId)?.addEventListener('click', () => {
    offset = Math.max(0, offset - metrics().visible); upd();
  });
  document.getElementById(nextId)?.addEventListener('click', () => {
    const { visible } = metrics();
    offset = Math.min(Math.max(0, track.children.length - visible), offset + visible);
    upd();
  });
  window.addEventListener('resize', upd);
  // Allow callers (e.g. source switch) to snap back to the start.
  track._resetSlider = () => { offset = 0; upd(); };
}
function resetSlider(trackId) {
  const t = document.getElementById(trackId);
  if (t && typeof t._resetSlider === 'function') t._resetSlider();
}

/* ── Search autocomplete (typeahead) ────────────────────────────────────────
   Debounced suggestions under the search bar as you type (≥2 chars). Clicking
   a suggestion does NOT request anything — it fills the search box and runs
   the full search, and you request from the result tiles like normal. Deezer
   powers the suggestions (/api/search/suggest — fast + has artwork); pressing
   Enter with no row highlighted still runs the search on whatever you typed. */
function hideSearchSuggest() {
  const box = document.getElementById('search-suggest');
  if (box) { box.classList.remove('open'); box.innerHTML = ''; }
}
function initSearchSuggest() {
  const input = document.getElementById('search-input');
  const box   = document.getElementById('search-suggest');
  if (!input || !box) return;
  let timer = null, seq = 0, activeIdx = -1;

  const hide = () => { hideSearchSuggest(); activeIdx = -1; };

  const render = items => {
    if (!items.length) return hide();
    box.innerHTML = items.map(it => {
      const isAlbum = it.type === 'album';
      const name    = isAlbum ? (it.title || 'Unknown') : (it.name || 'Unknown');
      const img     = it.thumb || it.image || it.cover || fallback(name);
      // What gets typed into the box + searched when this row is clicked.
      // For albums we include the artist so MusicBrainz ranks the right one.
      const q = isAlbum ? `${name} ${it.artist || ''}`.trim() : name;
      return `<button type="button" class="suggest-item" data-q="${esc(q)}">
        <img class="suggest-img${isAlbum ? '' : ' round'}" src="${esc(img)}" alt="" loading="lazy" data-fallback="${esc(fallback(name))}">
        <span class="suggest-text">
          <span class="suggest-name">${esc(name)}</span>
          ${isAlbum ? `<span class="suggest-sub">${esc(it.artist||'')}${it.year ? ' · ' + esc(it.year) : ''}</span>` : ''}
        </span>
        <span class="suggest-cta">Search →</span>
      </button>`;
    }).join('');
    box.classList.add('open');
    activeIdx = -1;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return hide();
    timer = setTimeout(async () => {
      const mySeq = ++seq;   // drop stale responses that arrive out of order
      const type  = document.querySelector('.search-type-btn.active')?.dataset.type || 'artist';
      try {
        const d = await api(`/api/search/suggest?q=${encodeURIComponent(q)}&type=${type}`);
        if (mySeq === seq) render(d.items || []);
      } catch { if (mySeq === seq) hide(); }
    }, 280);
  });

  input.addEventListener('keydown', e => {
    const items = box.querySelectorAll('.suggest-item');
    const open  = box.classList.contains('open') && items.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      activeIdx = e.key === 'ArrowDown'
        ? (activeIdx + 1) % items.length
        : (activeIdx - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      items[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && activeIdx >= 0) { items[activeIdx].click(); hide(); }
      else { clearTimeout(timer); hide(); doSearch(); }
    } else if (e.key === 'Escape') {
      hide();
    }
  });

  // Clicking a suggestion fills the search box with that name and runs the
  // full search — requesting happens from the result tiles, not the dropdown.
  box.addEventListener('click', e => {
    const row = e.target.closest('.suggest-item');
    if (!row) return;
    clearTimeout(timer);
    input.value = row.dataset.q || '';
    hide();
    doSearch();
  });

  // Click anywhere outside the search bar closes the dropdown.
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-bar')) hide();
  });
}

/* ── Search ─────────────────────────────────────────────────────────────── */
/* Sequence guard: without it a slower earlier response could overwrite a newer
   one, so fast retyping (or the duplicated Enter handler that used to fire two
   searches at once) rendered results for a query the user had moved on from.
   The typeahead in this same file already did this correctly. */
let _searchSeq = 0;
async function doSearch() {
  const q    = document.getElementById('search-input').value.trim();
  const type = document.querySelector('.search-type-btn.active')?.dataset.type || 'artist';
  if (!q) return;
  const mySeq = ++_searchSeq;
  const wrap = document.getElementById('search-results-wrap');
  wrap.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const results = await api(`/api/search?q=${encodeURIComponent(q)}&type=${type}`);
    if (mySeq !== _searchSeq) return;                      // superseded
    wrap.innerHTML = results.length
      ? `<div class="music-grid">${results.map(r => type==='album' ? albumTileHTML(r) : artistTileHTML(r)).join('')}</div>`
      : '<div class="empty-state"><div class="empty-state-icon">🔍</div><h3>No results</h3></div>';
    // After rendering, ask Lidarr which results are already in the library and
    // flag those tiles (everything is added/checked as the artist).
    if (results.length) flagInLibrary(wrap, results, type, () => mySeq === _searchSeq);
  } catch(e) {
    if (mySeq !== _searchSeq) return;
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Search failed</h3><p>${esc(e.message)}</p></div>`;
  }
}

/* Check search/mood results against the Lidarr library and badge in-library
   tiles. ONE batched request for the whole set (not one per tile) so we never
   stampede Lidarr. deep:true resolves provider aliases server-side (Deezer's
   "STS9" vs Lidarr's "Sound Tribe Sector 9") via Lidarr's own lookup, checked
   by ID. Failures are silent (best-effort hint). */
async function flagInLibrary(wrap, results, type, stillCurrent) {
  const nameOf = r => (type === 'album' ? (r.artist || '') : (r.name || '')).trim();
  const unique = [...new Set(results.map(nameOf).filter(Boolean))];
  if (!unique.length) return;
  let map = {};
  try {
    const res = await api('/api/lidarr/in-library-batch', { method: 'POST', body: JSON.stringify({ names: unique, deep: true }) });
    if (res.configured === false) return;
    map = res.results || {};
  } catch { return; /* non-critical hint */ }
  // Re-query the tiles AFTER the await. Capturing the NodeList first meant a
  // re-render during the round-trip left us indexing into detached nodes, so
  // badges landed on nothing (or on the wrong tiles).
  if (stillCurrent && !stillCurrent()) return;
  const tiles = wrap.querySelectorAll('.music-tile');
  results.forEach((r, i) => {
    const tile = tiles[i];
    if (tile && map[nameOf(r)]) markTileInLibrary(tile);
  });
}

/* Visually mark a tile as already-in-library and route its Request buttons to
   an "already in library" popup instead of opening the request modal. */
function markTileInLibrary(tile) {
  tile.classList.add('in-library');
  const wrapImg = tile.querySelector('.tile-img-wrap');
  if (wrapImg && !wrapImg.querySelector('.in-library-badge')) {
    const b = document.createElement('span');
    b.className = 'in-library-badge';
    b.textContent = '📚 In Library';
    wrapImg.appendChild(b);
  }
  tile.querySelectorAll('[data-item-key]').forEach(btn => {
    btn.dataset.inLibrary = '1';
    if (/request/i.test(btn.textContent)) btn.textContent = btn.textContent.replace(/\+?\s*Request/i, 'In Library');
  });
}

/* Badge Discover tiles whose artist is already in the Lidarr library. Scans the
   given container (default: the whole Discover content area), collects the
   unique artist names from data-artist, asks Lidarr about each one once, then
   marks every matching tile. Best-effort: failures are silently ignored. */
let _libStatusCache = {};   // artistName(lowercased) -> bool, for this session
async function flagDiscoverInLibrary(root) {
  const scope = root || document.getElementById('discover-content');
  if (!scope) return;
  const tiles = Array.from(scope.querySelectorAll('.music-tile[data-artist]'));
  if (!tiles.length) return;

  // Unique artist names still needing a lookup.
  const names = [...new Set(
    tiles.map(t => (t.dataset.artist || '').trim()).filter(Boolean)
  )];
  const unknown = names.filter(n => _libStatusCache[n.toLowerCase()] === undefined);

  // ONE batched request for everything we don't yet know about (not one per
  // tile) — keeps Lidarr from being hit once per card.
  // Only cache DEFINITIVE answers. Previously a Lidarr outage — or simply not
  // having Lidarr linked yet — wrote `false` for every name, and since the
  // refill only re-queries names whose entry is `undefined`, one bad moment
  // permanently disabled in-library badging for the rest of the session.
  if (unknown.length) {
    try {
      const res = await api('/api/lidarr/in-library-batch', { method: 'POST', body: JSON.stringify({ names: unknown }) });
      if (res.configured !== false && !res.error) {
        const map = res.results || {};
        unknown.forEach(n => { _libStatusCache[n.toLowerCase()] = !!map[n]; });
      }
    } catch { /* leave them undefined so the next render retries */ }
  }

  // Apply badges from the (now-populated) cache.
  tiles.forEach(tile => {
    const name = (tile.dataset.artist || '').trim().toLowerCase();
    if (name && _libStatusCache[name] && !tile.classList.contains('in-library')) {
      markTileInLibrary(tile);
    }
  });
}


async function loadMyRequests() {
  const wrap = document.getElementById('my-requests-wrap');
  wrap.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const reqs = await api('/api/requests/mine');
    document.getElementById('my-request-count').textContent = `${reqs.length} request${reqs.length!==1?'s':''}`;
    wrap.innerHTML = requestsTableHTML(reqs, false);
  } catch(e) { wrap.innerHTML = `<p style="color:var(--text-muted);padding:20px">${esc(e.message)}</p>`; }
}
async function handleMyRequestsClick(e) {
  const btn = e.target.closest('.req-del');
  if (!btn || !confirm('Delete this request?')) return;
  try { await api(`/api/requests/${btn.dataset.id}`, { method:'DELETE' }); toast('Deleted'); loadMyRequests(); }
  catch(e) { toast(e.message, 'error'); }
}

/* ── All Requests ───────────────────────────────────────────────────────── */
async function loadAllRequests() {
  const wrap = document.getElementById('all-requests-wrap');
  wrap.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  loadRequestStats();   // fire-and-forget — keeps the counter tiles + active highlight in step with the table

  // Build query string from the filter controls. The backend understands
  // search / status / type, so dashboards using the API get the same filtering.
  const search = document.getElementById('ar-search')?.value.trim() || '';
  const status = document.getElementById('ar-status')?.value || '';
  const type   = document.getElementById('ar-type')?.value   || '';
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  if (type)   params.set('type', type);
  const qs = params.toString() ? `?${params.toString()}` : '';

  try {
    const reqs = await api(`/api/requests${qs}`);
    const countEl = document.getElementById('all-request-count');
    if (countEl) countEl.textContent = `${reqs.length} request${reqs.length !== 1 ? 's' : ''}`;
    wrap.innerHTML = requestsTableHTML(reqs, true);
    // Viewing the full list = "I've checked these". Advance the synced seen
    // marker so no browser or phone re-announces them. Skipped when filters
    // are active — a filtered view may be hiding newer, genuinely-unseen ones.
    if (!search && !status && !type) markRequestsSeen(reqs);
  }
  catch(e) { wrap.innerHTML = `<p style="color:var(--text-muted);padding:20px">${esc(e.message)}</p>`; }
}
async function handleAllRequestsClick(e) {
  // Approve — sends the parked request to Lidarr. On a Lidarr failure the
  // server keeps it pending (retriable), which the response reflects.
  const ap = e.target.closest('.req-approve');
  if (ap) {
    ap.disabled = true; ap.textContent = '⏳️';
    try {
      const r = await api(`/api/requests/${ap.dataset.id}/approve`, { method:'POST' });
      const label = r.albumName || r.artistName || 'Request';
      if (r.approvalStatus === 'approved') {
        if (r.lidarrStatus === 'exists') toast(`📚 "${label}" approved — already in your Lidarr library`, 'info');
        else                             toast(`✅️ "${label}" approved & sent to Lidarr`, 'success');
      } else {
        toast(`❌ ${r.lidarrMessage || 'Lidarr rejected the add — still pending'}`, 'error');
      }
    } catch(e) { toast(e.message, 'error'); }
    loadAllRequests();
    return;
  }
  // Reject — no Lidarr involvement, just marks the request rejected.
  const rj = e.target.closest('.req-reject');
  if (rj) {
    // Ask for a reason. The server has always accepted and stored one; the UI
    // just never collected it, so the requester was told "rejected" with no
    // explanation. Cancel aborts; empty is allowed.
    const reason = prompt('Reject this request?\n\nOptionally tell the requester why:', '');
    if (reason === null) return;
    rj.disabled = true;
    try {
      const r = await api(`/api/requests/${rj.dataset.id}/reject`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() })
      });
      toast(`🚫 "${r.albumName || r.artistName || 'Request'}" rejected`);
    } catch(e) { toast(e.message, 'error'); }
    loadAllRequests();
    return;
  }
  const btn = e.target.closest('.req-del');
  if (!btn || !confirm('Delete this request?')) return;
  try { await api(`/api/requests/${btn.dataset.id}`, { method:'DELETE' }); toast('Deleted'); loadAllRequests(); }
  catch(e) { toast(e.message, 'error'); }
}

function lidarrBadge(r) {
  // status now carries a real lifecycle: pending → sent → partial → available.
  const s = r.status === 'available' || r.status === 'partial'
    ? r.status
    : (r.lidarrStatus || r.status || '');
  const m = esc(r.lidarrMessage || '');
  const failedApproval = r.lastApprovalError ? ` — ${esc(r.lastApprovalError)}` : '';
  if (s === 'available')      return `<span class="lb lb-available" title="${esc(r.availableAt ? 'Available since ' + new Date(r.availableAt).toLocaleString() : m)}">🎉 Available</span>`;
  if (s === 'partial')        return `<span class="lb lb-partial" title="${m}">⬇️ Downloading</span>`;
  if (s === 'sent')           return `<span class="lb lb-sent"   title="${m}">✅️ Sent to Lidarr</span>`;
  if (s === 'exists')         return `<span class="lb lb-exists" title="${m}">📚 In Library</span>`;
  if (s === 'pending')        return `<span class="lb lb-warn"   title="${m}${failedApproval}">🕓 Pending approval</span>`;
  if (s === 'rejected')       return `<span class="lb lb-rejected" title="${m}">🚫 Rejected</span>`;
  if (s === 'not_found')      return `<span class="lb lb-warn"   title="${m}">⚠️ Not found</span>`;
  if (s === 'error')          return `<span class="lb lb-err"    title="${m}">❌ ${m||'Error'}</span>`;
  if (s === 'not_configured') return '<span class="lb lb-dim">🔌 Lidarr not configured</span>';
  if (s === 'approved')       return '<span class="lb lb-sent"   title="">✅️ Sent to Lidarr</span>';
  return '<span class="lb lb-dim">⏳️ Pending</span>';
}

/* Approval-state helpers — legacy rows (pre-2.6) have no approvalStatus, so
   fall back to the plain status field. */
function reqIsPending(r)  { return r.approvalStatus ? r.approvalStatus === 'pending'  : r.status === 'pending'; }
function reqIsRejected(r) { return r.approvalStatus ? r.approvalStatus === 'rejected' : r.status === 'rejected'; }

function requestsTableHTML(requests, isAdmin) {
  if (!requests.length)
    return '<div class="empty-state"><div class="empty-state-icon">📋</div><h3>No requests yet</h3><p>Use Discover or Search to add music</p></div>';
  const uTh = isAdmin ? '<th>User</th>' : '';
  const rows = requests.map(r => {
    const cov = r.cover
      ? `<img class="req-cover" src="${esc(r.cover)}" data-hide-on-error alt="">`
      : '<div class="req-cover"></div>';
    const uTd = isAdmin
      ? `<td class="rt-user" style="font-size:0.78rem;color:var(--text-muted)">${esc(r.username||'—')}</td>`
      : '';
    // Compact meta line — only shown on phones, where the Type / Quality /
    // User / Date columns are folded away and each row renders as a card.
    const date  = new Date(r.createdAt).toLocaleDateString();
    const mmeta = [r.type || 'artist', r.quality || null, isAdmin ? (r.username || null) : null, date]
      .filter(Boolean).map(esc).join(' · ');
    // Admin moderation controls: pending rows get Approve + Reject; rejected
    // rows keep an Approve button so a change of heart can still send it.
    let modBtns = '';
    if (isAdmin && reqIsPending(r)) {
      modBtns = `<button class="btn btn-approve btn-sm req-approve" data-id="${r.id}" title="Approve — send to Lidarr">✓ Approve</button>
                 <button class="btn btn-ghost btn-sm req-reject" data-id="${r.id}" title="Reject this request">✕ Reject</button>`;
    } else if (isAdmin && reqIsRejected(r)) {
      modBtns = `<button class="btn btn-approve btn-sm req-approve" data-id="${r.id}" title="Approve after all — send to Lidarr">✓ Approve</button>`;
    }
    return `<tr>
      <td class="rt-cover">${cov}</td>
      <td class="rt-title"><strong>${esc(r.artistName||'—')}</strong>${r.albumName?`<br><span class="rt-album" style="color:var(--text-muted);font-size:0.78rem">${esc(r.albumName)}</span>`:''}<div class="rt-mmeta">${mmeta}</div></td>
      <td class="rt-type" style="font-size:0.78rem">${esc(r.type||'artist')}</td>
      <td class="rt-quality" style="font-size:0.78rem">${esc(r.quality||'—')}</td>
      <td class="rt-status">${lidarrBadge(r)}</td>
      ${uTd}
      <td class="rt-date" style="font-size:0.72rem;color:var(--text-muted)">${date}</td>
      <td class="rt-actions">${modBtns}<button class="btn btn-danger btn-sm req-del" data-id="${r.id}" title="Delete">🗑</button></td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="requests-table rt-cards">
    <thead><tr><th></th><th>Title</th><th>Type</th><th>Quality</th><th>Lidarr</th>${uTh}<th>Date</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   DOWNLOAD ACTIVITY
   GET /api/lidarr/queue has existed (and been carefully memoised) since 2.7,
   but nothing in the SPA ever called it — so "where is my album?" could only
   be answered by giving the user a Lidarr login, which defeats the point of a
   request frontend. Polling is safe: the server memoises the queue for 15s per
   limit, so any number of watching browsers cost Lidarr at most 4 reads/min.
   ══════════════════════════════════════════════════════════════════════════ */
let dlTimer = null;
const DL_POLL_MS = 8000;

function fmtBytes(n) {
  if (!n || n < 0) return '—';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtTimeleft(t) {
  if (!t) return '—';
  const m = /^(\d+):(\d{2}):(\d{2})/.exec(t);
  if (!m) return esc(t);
  const [, h, mi] = m;
  return +h > 0 ? `${+h}h ${+mi}m` : `${+mi}m`;
}

async function loadDownloads() {
  const wrap = document.getElementById('downloads-wrap');
  if (!wrap) return;
  try {
    const d = await api('/api/lidarr/queue?limit=50');
    const recs = d.records || [];
    const countEl = document.getElementById('downloads-count');
    if (countEl) countEl.textContent = `${d.total || 0} item${(d.total || 0) !== 1 ? 's' : ''} in Lidarr's queue`;
    if (!recs.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💤</div><h3>Nothing downloading</h3><p>Lidarr\'s queue is empty right now.</p></div>';
      return;
    }
    wrap.innerHTML = `<div class="dl-list">${recs.map(r => {
      const pct     = r.progress == null ? 0 : Math.max(0, Math.min(100, r.progress));
      const stalled = /warning|failed/i.test(r.trackedDownloadStatus || '') || Boolean(r.errorMessage);
      const notes   = [r.errorMessage, ...(r.statusMessages || []).flatMap(m => m.messages || [])]
        .filter(Boolean).slice(0, 2).map(esc).join(' · ');
      return `<div class="dl-row${stalled ? ' dl-stalled' : ''}">
        <div class="dl-main">
          <div class="dl-title">${esc(r.album || 'Unknown release')}</div>
          <div class="dl-sub">${esc(r.artist || '')}${r.indexer ? ` · ${esc(r.indexer)}` : ''}${r.protocol ? ` · ${esc(r.protocol)}` : ''}</div>
          ${notes ? `<div class="dl-note">⚠️ ${notes}</div>` : ''}
        </div>
        <div class="dl-progress-wrap">
          <div class="dl-bar"><div class="dl-bar-fill${stalled ? ' stalled' : ''}" style="width:${pct}%"></div></div>
          <div class="dl-meta">${pct}% · ${fmtBytes(r.size - r.sizeleft)} / ${fmtBytes(r.size)} · ${fmtTimeleft(r.timeleft)}</div>
        </div>
        <div class="dl-actions">
          <span class="lb lb-dim dl-state">${esc(r.trackedDownloadState || r.status || '')}</span>
          ${ROLE === 'admin' ? `<button class="btn btn-danger btn-sm dl-remove" data-id="${esc(String(r.id))}" title="Remove from Lidarr's queue">✕</button>` : ''}
        </div>
      </div>`;
    }).join('')}</div>`;
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Could not read Lidarr's queue</h3><p>${esc(e.message)}</p></div>`;
  }
}

function startDownloadsPolling() {
  loadDownloads();
  clearInterval(dlTimer);
  // Only poll while the page is actually being looked at.
  dlTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadDownloads();
  }, DL_POLL_MS);
}
function stopDownloadsPolling() { clearInterval(dlTimer); dlTimer = null; }

async function handleDownloadsClick(e) {
  const btn = e.target.closest('.dl-remove');
  if (!btn) return;
  if (!confirm('Remove this item from Lidarr\'s download queue?')) return;
  btn.disabled = true;
  try {
    await api(`/api/lidarr/queue/${btn.dataset.id}`, { method: 'DELETE' });
    toast('Removed from queue');
  } catch (err) { toast(err.message, 'error'); }
  loadDownloads();
}

/* ══════════════════════════════════════════════════════════════════════════
   NOTIFICATION TARGETS (Admin)
   ══════════════════════════════════════════════════════════════════════════ */
async function loadNotificationTargets() {
  const wrap = document.getElementById('notif-targets-wrap');
  if (!wrap) return;
  try {
    const d = await api('/api/settings/notifications');
    if (!d.targets.length) {
      wrap.innerHTML = '<div class="conn-hint">No targets yet — add one so requests reach you when nobody has AudioSeerr open.</div>';
      return;
    }
    wrap.innerHTML = `<div class="table-wrap"><table class="requests-table">
      <thead><tr><th>Name</th><th>Type</th><th>URL</th><th>Events</th><th>Last test</th><th></th></tr></thead>
      <tbody>${d.targets.map(t => `<tr>
        <td><strong>${esc(t.label)}</strong></td>
        <td>${esc(t.type)}</td>
        <td style="font-size:0.72rem;color:var(--text-muted)">${esc(t.urlMasked)}</td>
        <td style="font-size:0.72rem;color:var(--text-muted)">${t.events.length === 6 ? 'all' : esc(t.events.join(', '))}</td>
        <td style="font-size:0.72rem;color:var(--text-muted)">${t.lastResult ? `${t.lastResult === 'ok' ? '✅' : '❌'} ${new Date(t.lastAt).toLocaleString()}` : '—'}</td>
        <td style="display:flex;gap:6px;">
          <button class="btn btn-ghost btn-sm notif-action" data-action="test" data-id="${esc(t.id)}">Send test</button>
          <button class="btn btn-danger btn-sm notif-action" data-action="delete" data-id="${esc(t.id)}">Remove</button>
        </td>
      </tr>`).join('')}</tbody></table></div>`;
  } catch (e) {
    wrap.innerHTML = `<div class="conn-hint">${esc(e.message)}</div>`;
  }
}

async function addNotificationTarget() {
  const type  = document.getElementById('notif-type')?.value;
  const label = document.getElementById('notif-label')?.value.trim();
  const url   = document.getElementById('notif-url')?.value.trim();
  if (!url) return toast('Paste the webhook URL first', 'error');
  try {
    await api('/api/settings/notifications', { method: 'POST', body: JSON.stringify({ type, label, url }) });
    const u = document.getElementById('notif-url'); if (u) u.value = '';
    const l = document.getElementById('notif-label'); if (l) l.value = '';
    toast('🔔 Notification target added');
    loadNotificationTargets();
  } catch (e) { toast(e.message, 'error'); }
}

async function handleNotifClick(e) {
  const btn = e.target.closest('.notif-action');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'test') {
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await api(`/api/settings/notifications/${id}/test`, { method: 'POST' });
      toast(r.ok ? '✅ Test notification delivered' : `❌ ${r.error}`, r.ok ? 'success' : 'error');
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false; btn.textContent = 'Send test';
    loadNotificationTargets();
  } else if (action === 'delete') {
    if (!confirm('Remove this notification target?')) return;
    try { await api(`/api/settings/notifications/${id}`, { method: 'DELETE' }); toast('Removed'); loadNotificationTargets(); }
    catch (err) { toast(err.message, 'error'); }
  }
}

/* Authenticated file download. A plain <a download> can't attach the bearer
   token, so fetch it with auth and hand the browser a blob instead. */
async function downloadWithAuth(path, fallbackName) {
  try {
    const r = await fetch(path, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const cd   = r.headers.get('Content-Disposition') || '';
    const name = (/filename="([^"]+)"/.exec(cd) || [])[1] || fallbackName;
    const url  = URL.createObjectURL(await r.blob());
    const a    = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) { toast(`Download failed: ${e.message}`, 'error'); }
}

/* ── Retention (Admin) ──────────────────────────────────────────────────── */
async function loadRetentionSettings() {
  const days = document.getElementById('set-keep-days');
  const max  = document.getElementById('set-keep-max');
  if (!days || !max) return;
  try {
    const c = await api('/api/settings/retention');
    days.value = c.keepDays || '';
    max.value  = c.keepMax  || '';
  } catch { /* leave blank */ }
}
async function saveRetentionSettings() {
  const days = document.getElementById('set-keep-days');
  const max  = document.getElementById('set-keep-max');
  try {
    const c = await api('/api/settings/retention', {
      method: 'PUT',
      body: JSON.stringify({ keepDays: days.value || 0, keepMax: max.value || 0 })
    });
    toast(c.keepDays || c.keepMax
      ? `🧹 Retention: ${c.keepDays ? `keep ${c.keepDays} days` : 'no age limit'}, ${c.keepMax ? `max ${c.keepMax} rows` : 'no count limit'}`
      : '🧹 Retention off — requests are kept forever');
  } catch (e) { toast(e.message, 'error'); }
}

/* ── Change password (self-service) ───────────────────────────────────────
   Any signed-in user changes their OWN password by confirming the current one.
   Admins resetting OTHER users still use the Edit User modal (password field). */
function openChangePassword() {
  ['cp-current','cp-new','cp-confirm'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; el.type = 'password'; }
  });
  // Reset any revealed-eye state to hidden (scoped to THIS modal — the
  // Connections panel has its own toggles that shouldn't be touched here)
  document.querySelectorAll('#modal-change-password .pw-toggle[data-target]').forEach(btn => {
    const eye = btn.querySelector('.pw-eye'), eyeOff = btn.querySelector('.pw-eye-off');
    if (eye)    eye.style.display    = '';
    if (eyeOff) eyeOff.style.display = 'none';
    btn.setAttribute('aria-label', 'Show password');
  });
  openModal('modal-change-password');
  setTimeout(() => document.getElementById('cp-current')?.focus(), 60);
}

async function submitChangePassword() {
  const cur = document.getElementById('cp-current').value;
  const nw  = document.getElementById('cp-new').value;
  const cf  = document.getElementById('cp-confirm').value;
  if (!cur || !nw)   return toast('Fill in every field', 'error');
  if (nw.length < 4) return toast('New password must be at least 4 characters', 'error');
  if (nw !== cf)     return toast('New passwords do not match', 'error');
  if (nw === cur)    return toast('New password must be different from the current one', 'error');

  const btn = document.getElementById('cp-submit');
  const lbl = btn.textContent;
  btn.disabled = true; btn.textContent = 'Updating…';
  try {
    const r = await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: cur, newPassword: nw })
    });
    // Changing the password revokes every OTHER session; the server hands this
    // one a fresh token so the user isn't logged out by their own change.
    if (r.token) { localStorage.setItem('as_token', r.token); TOKEN = r.token; }
    toast('🔑 Password updated — other devices have been signed out');
    closeModal('modal-change-password');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = lbl;
  }
}

/* ── Users ──────────────────────────────────────────────────────────────── */
let editingUserId = null;
async function loadUsers() {
  const tbody = document.getElementById('users-tbody');
  tbody.innerHTML = '<tr><td colspan="7"><div class="spinner-wrap"><div class="spinner"></div></div></td></tr>';
  try {
    const users = await api('/api/users');
    // Admins always auto-approve themselves, so the per-user flag only means
    // anything for regular users — admins render as a dash.
    const autoCell = u => u.role === 'admin'
      ? '<span style="color:var(--text-faint)" title="Admins are always auto-approved">—</span>'
      : (u.autoApprove ? '<span style="color:var(--teal)" title="Requests skip approval">✓</span>'
                       : '<span style="color:var(--text-faint)" title="Requests need admin approval when global auto-approve is off">✗</span>');
    tbody.innerHTML = users.map(u => `<tr>
      <td><strong>${esc(u.username)}</strong></td>
      <td><span class="role-badge role-${u.role}">${u.role}</span></td>
      <td>${u.requestsToday ?? 0}</td>
      <td>${u.requestLimit}</td>
      <td>${u.canRequest ? '<span style="color:var(--teal)">✓</span>' : '<span style="color:var(--text-faint)">✗</span>'}</td>
      <td>${autoCell(u)}</td>
      <td style="display:flex;gap:6px;">
        <button class="btn btn-ghost btn-sm user-action" data-id="${u.id}" data-action="edit">Edit</button>
        ${u.role !== 'admin' ? `<button class="btn btn-danger btn-sm user-action" data-id="${u.id}" data-action="delete">Delete</button>` : ''}
      </td>
    </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);padding:20px">${esc(e.message)}</td></tr>`;
  }
}
async function handleUserTableClick(e) {
  const btn = e.target.closest('.user-action');
  if (!btn) return;
  const { id, action } = btn.dataset;
  if (action === 'edit') {
    try { const us = await api('/api/users'); const u = us.find(x => x.id===id); if (u) openUserModal(u); else toast('Not found','error'); }
    catch(e) { toast(e.message,'error'); }
  } else if (action === 'delete') {
    if (!confirm('Delete this user?')) return;
    try { await api(`/api/users/${id}`, { method:'DELETE' }); toast('Deleted'); loadUsers(); }
    catch(e) { toast(e.message,'error'); }
  }
}
function openUserModal(user = null) {
  editingUserId = user ? user.id : null;
  document.getElementById('user-modal-title').textContent = user ? 'Edit User' : 'Add User';
  document.getElementById('new-username').value    = user?.username || '';
  document.getElementById('new-password').value    = '';
  document.getElementById('new-password').placeholder = user ? 'Leave blank to keep' : 'Password';
  document.getElementById('new-role').value        = user?.role || 'user';
  document.getElementById('new-limit').value       = user?.requestLimit ?? 10;
  document.getElementById('new-can-request').checked = user ? Boolean(user.canRequest) : true;
  document.getElementById('new-auto-approve').checked = user ? Boolean(user.autoApprove) : false;
  openModal('modal-add-user');
}
async function saveUser() {
  const username     = document.getElementById('new-username').value.trim();
  const password     = document.getElementById('new-password').value;
  const role         = document.getElementById('new-role').value;
  const requestLimit = parseInt(document.getElementById('new-limit').value) || 10;
  const canRequest   = document.getElementById('new-can-request').checked;
  const autoApprove  = document.getElementById('new-auto-approve').checked;
  if (!username) return toast('Username required','error');
  if (!editingUserId && !password) return toast('Password required for new users','error');
  try {
    const body = { username, role, requestLimit, canRequest, autoApprove };
    if (password) body.password = password;
    if (editingUserId) { await api(`/api/users/${editingUserId}`,{method:'PATCH',body:JSON.stringify(body)}); toast('User updated'); }
    else               { await api('/api/users',{method:'POST',body:JSON.stringify(body)}); toast('User created'); }
    closeModal('modal-add-user');
    loadUsers();
  } catch(e) { toast(e.message,'error'); }
}
/* ── Request counters (All Requests page) ─────────────────────────────────
   Four tiles above the table: Total / Approved / Pending / Rejected. Fed by
   GET /api/requests/stats, which shares its counting rule with /api/summary —
   so these numbers always match what a dashboard tile fed by that endpoint shows.
   Tapping a tile filters the table below to that state (syncing the status
   dropdown); the tile matching the current filter is highlighted. Refreshed
   automatically on every table reload, so approve/reject/delete actions and
   filter changes keep the counters live. */
async function loadRequestStats() {
  const wrap = document.getElementById('request-stats');
  if (!wrap) return;
  try {
    const s = await api('/api/requests/stats');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('stat-total',     s.total);
    set('stat-approved',  s.approved);
    set('stat-available', s.available ?? 0);
    set('stat-pending',   s.pending);
    set('stat-rejected',  s.rejected);
    // The approved tile doubles as a delivery-health readout when Lidarr
    // failed some of them (error / not found / not configured).
    const apTile = document.getElementById('stat-approved')?.closest('.stat-tile');
    if (apTile) apTile.title = s.problem > 0
      ? `Show approved requests — ⚠️ ${s.problem} had Lidarr delivery problems`
      : 'Show approved requests';
    // Light the pending tile up when something is actually waiting.
    document.getElementById('stat-pending')?.closest('.stat-tile')?.classList.toggle('stat-hot', s.pending > 0);
    // Stats are the authoritative pending count — sync the nav badge too.
    updatePendingBadge(s.pending);
  } catch (e) {
    ['stat-total','stat-approved','stat-available','stat-pending','stat-rejected'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '—';
    });
  }
  syncActiveStatTile();
}

/* Highlight the tile matching the status dropdown (only for the states the
   tiles represent — Lidarr-level filters like "sent" highlight nothing). */
function syncActiveStatTile() {
  const current = document.getElementById('ar-status')?.value ?? '';
  document.querySelectorAll('#request-stats .stat-tile').forEach(t => {
    t.classList.toggle('active', (t.dataset.filter ?? '') === current);
  });
}

function handleRequestStatsClick(e) {
  const tile = e.target.closest('.stat-tile');
  if (!tile) return;
  // Drive the table through its own filter controls, then reload — the tiles
  // and the dropdown always agree.
  const st = document.getElementById('ar-status'); if (st) st.value = tile.dataset.filter ?? '';
  const se = document.getElementById('ar-search'); if (se) se.value = '';
  const ty = document.getElementById('ar-type');   if (ty) ty.value = '';
  loadAllRequests();
}

/* ── Lidarr add behaviour (Admin → Connections card) ──────────────────────
   How much work each add creates for Lidarr. monitor:'all' + searchOnAdd is
   the classic full-discography behaviour; the other modes exist precisely so
   an admin can calm Lidarr down when adds are hammering it. Instant-save. */
function setLidarrAddHint(cfg) {
  const hint = document.getElementById('lidarr-add-hint');
  if (!hint) return;
  hint.textContent = cfg.searchOnAdd
    ? 'Lidarr starts searching your indexers as soon as the artist is added.'
    : 'Artists are added quietly — Lidarr only grabs releases when you search manually or via its own RSS/schedule.';
}

/* Populate the root-folder and metadata-profile pickers from the live Lidarr
   config. Both were previously hardcoded to entry [0] server-side even though
   /api/lidarr/profiles already returned the full lists to the browser, so on a
   multi-root Lidarr every add silently landed in whichever root came first. */
async function loadLidarrTargets(cfg) {
  const rootSel = document.getElementById('set-lidarr-root');
  const metaSel = document.getElementById('set-lidarr-metadata');
  if (!rootSel && !metaSel) return;
  try {
    const p = await api('/api/lidarr/profiles');
    if (rootSel) {
      rootSel.innerHTML = `<option value="">Lidarr default (${esc(p.rootFolders[0]?.path || '—')})</option>` +
        p.rootFolders.map(r => `<option value="${esc(r.path)}">${esc(r.path)}</option>`).join('');
      rootSel.value = cfg.rootFolderPath || '';
      rootSel.disabled = false;
    }
    if (metaSel) {
      metaSel.innerHTML = `<option value="">Lidarr default (${esc(p.metadataProfiles[0]?.name || '—')})</option>` +
        p.metadataProfiles.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
      metaSel.value = cfg.metadataProfileId ? String(cfg.metadataProfileId) : '';
      metaSel.disabled = false;
    }
  } catch {
    if (rootSel) { rootSel.innerHTML = '<option value="">Lidarr not reachable</option>'; rootSel.disabled = true; }
    if (metaSel) { metaSel.innerHTML = '<option value="">Lidarr not reachable</option>'; metaSel.disabled = true; }
  }
}

async function loadLidarrAddSettings() {
  const sel = document.getElementById('set-lidarr-monitor');
  const sw  = document.getElementById('set-search-on-add');
  if (!sel || !sw) return;
  try {
    const cfg = await api('/api/settings/lidarr-add');
    sel.value  = cfg.monitor;
    sw.checked = Boolean(cfg.searchOnAdd);
    sel.disabled = sw.disabled = false;
    setLidarrAddHint(cfg);
    loadLidarrTargets(cfg);
  } catch (e) {
    sel.disabled = sw.disabled = true;
    const hint = document.getElementById('lidarr-add-hint');
    if (hint) hint.textContent = e.message;
  }
}

async function saveLidarrAddSettings() {
  const sel  = document.getElementById('set-lidarr-monitor');
  const sw   = document.getElementById('set-search-on-add');
  const root = document.getElementById('set-lidarr-root');
  const meta = document.getElementById('set-lidarr-metadata');
  if (!sel || !sw) return;
  sel.disabled = sw.disabled = true;
  try {
    const cfg = await api('/api/settings/lidarr-add', {
      method: 'PUT',
      body: JSON.stringify({
        monitor: sel.value,
        searchOnAdd: sw.checked,
        rootFolderPath:    root ? root.value : undefined,
        metadataProfileId: meta ? (meta.value || '') : undefined
      })
    });
    sel.value  = cfg.monitor;
    sw.checked = Boolean(cfg.searchOnAdd);
    setLidarrAddHint(cfg);
    const monitorLabel = { all:'all albums', latest:'latest album', future:'future releases', none:'nothing' }[cfg.monitor] || cfg.monitor;
    toast(`🎛 Lidarr adds: monitor ${monitorLabel}, search ${cfg.searchOnAdd ? 'ON' : 'OFF'}`);
  } catch (e) {
    toast(e.message, 'error');
    loadLidarrAddSettings();          // re-sync the controls with the server
  } finally {
    sel.disabled = sw.disabled = false;
  }
}

/* ── Request Approvals (Admin page) ───────────────────────────────────────
   Overseerr-style moderation. One global switch: ON = every request goes
   straight to Lidarr (the classic behaviour); OFF = requests from regular
   users land in "Pending approval" on All Requests, where the admin approves
   or rejects them. Per-user exceptions live on each user (Manage Users →
   Edit → "Auto-approve requests"); admins are always auto-approved. */
function setApprovalHint(on) {
  const hint = document.getElementById('auto-approve-hint');
  if (!hint) return;
  hint.textContent = on
    ? 'Every request is sent to Lidarr immediately. Turn this off to review requests before they reach Lidarr.'
    : 'New requests from regular users now wait in All Requests → Pending approval. Users with the per-user "Auto-approve" flag (Manage Users) still skip the queue; admins always do.';
}

async function loadApprovalSettings() {
  const sw = document.getElementById('set-auto-approve-all');
  if (!sw) return;
  try {
    const s = await api('/api/settings/approvals');
    sw.checked = Boolean(s.autoApproveAll);
    sw.disabled = false;
    setApprovalHint(sw.checked);
  } catch (e) {
    sw.disabled = true;
    const hint = document.getElementById('auto-approve-hint');
    if (hint) hint.textContent = e.message;
  }
}

async function saveApprovalSettings() {
  const sw = document.getElementById('set-auto-approve-all');
  if (!sw) return;
  const wanted = sw.checked;
  sw.disabled = true;
  try {
    const s = await api('/api/settings/approvals', {
      method: 'PUT',
      body: JSON.stringify({ autoApproveAll: wanted })
    });
    sw.checked = Boolean(s.autoApproveAll);
    setApprovalHint(sw.checked);
    toast(sw.checked ? '✅️ Auto-approve ON — requests go straight to Lidarr'
                     : '🕓 Auto-approve OFF — new requests now need your approval');
    refreshPendingCount();
  } catch (e) {
    sw.checked = !wanted;              // roll back the visual state on failure
    toast(e.message, 'error');
  } finally {
    sw.disabled = false;
  }
}

/* ── Connections (Admin page) ─────────────────────────────────────────────
   Link Lidarr (and optionally Last.fm) from inside the app. Values are saved
   server-side in db.json, so they're permanent and identical on every browser
   and phone; anything in .env acts as the fallback. Saved keys are never sent
   back to the browser — only a masked tail is shown. */
function connSourceLabel(source) {
  if (source === 'app') return 'saved in app settings';
  if (source === 'env') return 'from .env (save here to override)';
  return 'not set';
}
function setConnStatus(msg, kind = '') {
  const el = document.getElementById('conn-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = `conn-status${kind ? ' ' + kind : ''}`;
}

async function loadConnections() {
  const card = document.getElementById('connections-card');
  if (!card) return;
  setConnStatus('');
  try {
    const s = await api('/api/settings/connections');

    const urlInput = document.getElementById('set-lidarr-url');
    if (urlInput && document.activeElement !== urlInput) urlInput.value = s.lidarr.url || '';

    const lKey = document.getElementById('set-lidarr-key');
    if (lKey) {
      lKey.value = '';
      lKey.placeholder = s.lidarr.keyMasked ? `${s.lidarr.keyMasked} (saved — type to replace)` : 'Paste your Lidarr API key';
    }
    const fKey = document.getElementById('set-lastfm-key');
    if (fKey) {
      fKey.value = '';
      fKey.placeholder = s.lastfm.keyMasked ? `${s.lastfm.keyMasked} (saved — type to replace)` : 'Optional — from last.fm/api';
    }

    const lHint = document.getElementById('lidarr-conn-hint');
    if (lHint) lHint.textContent = s.lidarr.configured
      ? `✓ Lidarr linked — ${connSourceLabel(s.lidarr.source)}`
      : 'Lidarr is not linked yet — enter the URL and API key (Lidarr → Settings → General).';
    const fHint = document.getElementById('lastfm-conn-hint');
    if (fHint) fHint.textContent = s.lastfm.configured
      ? `✓ Last.fm key set — ${connSourceLabel(s.lastfm.source)}`
      : 'No Last.fm key — Discover still works via Deezer + iTunes.';

    // "Clear saved" affordances only make sense when an app-saved value exists.
    document.getElementById('conn-clear-lidarr-key')?.classList.toggle('hidden', s.lidarr.source !== 'app');
    document.getElementById('conn-clear-lastfm-key')?.classList.toggle('hidden', s.lastfm.source !== 'app');
  } catch (e) {
    setConnStatus(e.message, 'err');
  }
}

async function saveConnections() {
  const btn = document.getElementById('conn-save-btn');
  const url  = document.getElementById('set-lidarr-url')?.value.trim() ?? '';
  const lKey = document.getElementById('set-lidarr-key')?.value.trim() ?? '';
  const fKey = document.getElementById('set-lastfm-key')?.value.trim() ?? '';

  // Only send keys the admin actually typed — a blank field means "keep the
  // saved one", never "wipe it".
  const body = { lidarr: { url } };
  if (lKey) body.lidarr.apiKey = lKey;
  if (fKey) body.lastfm = { apiKey: fKey };

  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await api('/api/settings/connections', { method: 'PUT', body: JSON.stringify(body) });
    toast('Connections saved');
    setConnStatus('Saved — applied immediately, no restart needed.', 'ok');
    loadConnections();
    checkLidarrStatus();     // refresh the sidebar badge right away
  } catch (e) {
    toast(e.message, 'error');
    setConnStatus(e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

async function testLidarrConnection() {
  const btn = document.getElementById('conn-test-btn');
  const url  = document.getElementById('set-lidarr-url')?.value.trim() ?? '';
  const lKey = document.getElementById('set-lidarr-key')?.value.trim() ?? '';
  const body = {};
  if (url)  body.url = url;
  if (lKey) body.apiKey = lKey;   // omitted → server tests with the saved key
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  setConnStatus('Contacting Lidarr…');
  try {
    const r = await api('/api/settings/lidarr/test', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) setConnStatus(`✓ Connected — Lidarr v${r.version}`, 'ok');
    else      setConnStatus(`✕ ${r.error || 'Could not reach Lidarr'}`, 'err');
  } catch (e) {
    setConnStatus(`✕ ${e.message}`, 'err');   // setConnStatus uses textContent
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test connection'; }
  }
}

async function clearSavedKey(which) {
  const label = which === 'lidarr' ? 'Lidarr' : 'Last.fm';
  if (!confirm(`Remove the ${label} API key saved in the app? AudioSeerr will fall back to the value in .env (if any).`)) return;
  const body = which === 'lidarr' ? { lidarr: { apiKey: '' } } : { lastfm: { apiKey: '' } };
  try {
    await api('/api/settings/connections', { method: 'PUT', body: JSON.stringify(body) });
    toast(`${label} key removed`);
    loadConnections();
    checkLidarrStatus();
  } catch (e) { toast(e.message, 'error'); }
}

/* ── API keys ───────────────────────────────────────────────────────────── */
async function loadApiKeys() {
  const wrap = document.getElementById('apikeys-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';
  try {
    const keys = await api('/api/apikeys');
    if (!keys.length) {
      wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔑</div><h3>No API keys yet</h3><p>Generate one so other programs can connect.</p></div>';
      return;
    }
    const rows = keys.map(k => `<tr>
      <td><strong>${esc(k.label)}</strong></td>
      <td>
        <div class="api-key-cell">
          <input class="api-key-input" type="text" readonly value="${esc(k.key)}" aria-label="API key value">
          <button class="btn btn-ghost btn-sm api-key-action" data-action="copy" data-key="${esc(k.key)}" title="Copy">⧉ Copy</button>
        </div>
      </td>
      <td style="font-size:0.72rem;color:var(--text-muted)">${new Date(k.createdAt).toLocaleDateString()}</td>
      <td style="font-size:0.72rem;color:var(--text-muted)">${k.lastUsed ? new Date(k.lastUsed).toLocaleString() : '—'}</td>
      <td style="display:flex;gap:6px;">
        <button class="btn btn-ghost btn-sm api-key-action" data-action="regenerate" data-id="${k.id}" title="Generate a new value for this key">↻️ Regenerate</button>
        <button class="btn btn-danger btn-sm api-key-action" data-action="revoke" data-id="${k.id}" title="Revoke">Revoke</button>
      </td>
    </tr>`).join('');
    wrap.innerHTML = `<div class="table-wrap"><table class="requests-table">
      <thead><tr><th>Label</th><th>Key</th><th>Created</th><th>Last Used</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  } catch(e) {
    wrap.innerHTML = `<p style="color:var(--text-muted);padding:20px">${esc(e.message)}</p>`;
  }
}

async function generateApiKey() {
  const raw = prompt('Name this key (e.g. "Home Assistant", "n8n"):', '');
  if (raw === null) return;            // user cancelled
  const label = raw.trim();
  try {
    await api('/api/apikeys', { method:'POST', body: JSON.stringify({ label }) });
    toast('🔑 API key generated');
    loadApiKeys();
  } catch(e) { toast(e.message, 'error'); }
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); }
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast('Copied to clipboard');
  } catch { toast('Could not copy — select and copy manually', 'error'); }
}

async function handleApiKeysClick(e) {
  const btn = e.target.closest('.api-key-action');
  if (!btn) return;
  const { action, id, key } = btn.dataset;
  if (action === 'copy') {
    copyToClipboard(key);
  } else if (action === 'regenerate') {
    if (!confirm('Generate a new value for this key? Programs using the old value will stop working until updated.')) return;
    try { await api(`/api/apikeys/${id}/regenerate`, { method:'POST' }); toast('Key regenerated'); loadApiKeys(); }
    catch(e) { toast(e.message, 'error'); }
  } else if (action === 'revoke') {
    if (!confirm('Revoke this key? Any program using it will lose access immediately.')) return;
    try { await api(`/api/apikeys/${id}`, { method:'DELETE' }); toast('Key revoked'); loadApiKeys(); }
    catch(e) { toast(e.message, 'error'); }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN NEW-REQUEST NOTIFICATIONS
   Polls the requests feed and shows a popup whenever a request appears that
   this admin hasn't seen before. A "high-water mark" of the newest createdAt
   we've already notified about is kept in localStorage so a page reload
   doesn't replay old requests as new.
   ══════════════════════════════════════════════════════════════════════════ */
const NOTIF_POLL_MS  = 20000;        // check every 20s
let   notifPollTimer = null;
let   notifPollBusy  = false;

/* ── Pending-approval count badge ─────────────────────────────────────────
   Small counter on the "All Requests" nav items (sidebar + mobile bar) so a
   waiting queue is visible from anywhere in the app. Refreshed by the same
   admin poll that drives notifications, and immediately after any
   approve / reject / delete / toggle action. */
async function refreshPendingCount() {
  if (ROLE !== 'admin') return;
  try {
    const s = await api('/api/requests/stats');
    updatePendingBadge(s.pending || 0);
  } catch { /* transient — leave the badge as-is */ }
}
function updatePendingBadge(n) {
  document.querySelectorAll('.pending-badge').forEach(b => {
    if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.classList.remove('hidden'); }
    else       { b.classList.add('hidden'); }
  });
}

// The "seen" high-water mark lives ONLY in server preferences — the single
// source of truth shared by every browser and phone. It is monotonic on the
// server (can only advance), so no stale tab can rewind it and replay old
// requests. There is deliberately NO localStorage fallback: a per-browser copy
// is exactly what made already-checked requests pop up as new on other devices.
function getNotifSeenAt() {
  return PREFS.notifSeenAt ? new Date(PREFS.notifSeenAt).getTime() : 0;
}
function setNotifSeenAt(ts) {
  if (!ts || ts <= getNotifSeenAt()) return;      // forward-only, mirrors the server
  const iso = new Date(ts).toISOString();
  PREFS.notifSeenAt = iso;
  savePreferences({ notifSeenAt: iso });          // fire-and-forget sync
}
// Called whenever the admin actually LOOKS at requests (All Requests page) —
// seeing the list is what "checked them" means, so it advances the mark.
function markRequestsSeen(reqs) {
  if (ROLE !== 'admin' || !Array.isArray(reqs) || !reqs.length) return;
  const newest = Math.max(...reqs.map(r => new Date(r.createdAt).getTime()).filter(n => !isNaN(n)));
  if (newest) setNotifSeenAt(newest);
}

async function startRequestNotifications() {
  // One-time cleanup of the old per-browser marker (pre-2.5 releases).
  try { localStorage.removeItem('as_notif_seen_at'); } catch {}

  // The synced marker is required before we can tell new from old — never
  // start from defaults, or we'd re-announce things another device dismissed.
  while (!prefsLoaded) {
    await new Promise(r => setTimeout(r, 4000));
    await loadPreferences();
  }

  // Brand-new install (no marker anywhere yet): baseline to the newest existing
  // request so we don't fire popups for the entire backlog on first login.
  if (!getNotifSeenAt()) {
    try {
      const initial = await api('/api/requests?limit=1');
      const newest  = initial[0]?.createdAt ? new Date(initial[0].createdAt).getTime() : Date.now();
      setNotifSeenAt(newest);
    } catch { /* offline / transient — the poll below re-baselines safely */ }
  }

  const poll = async () => {
    // Only a tab the admin can actually SEE gets to notify (and advance the
    // mark) — a popup in a background tab would silently mark things seen.
    if (notifPollBusy || document.visibilityState === 'hidden') return;
    notifPollBusy = true;
    try {
      // Pick up marks advanced on OTHER devices first, so checking requests on
      // the desktop stops the phone from re-announcing them (and vice versa).
      try {
        const p = await api('/api/preferences');
        if (p?.notifSeenAt) {
          const serverMs = new Date(p.notifSeenAt).getTime();
          if (serverMs > getNotifSeenAt()) PREFS.notifSeenAt = p.notifSeenAt;
        }
      } catch { /* transient — compare against what we have */ }

      refreshPendingCount();           // fire-and-forget — keeps the nav badge live

      const reqs   = await api('/api/requests?limit=15');
      const seenAt = getNotifSeenAt();
      if (!seenAt) {                     // still no baseline → set one, don't flood
        if (reqs[0]?.createdAt) setNotifSeenAt(new Date(reqs[0].createdAt).getTime());
        return;
      }

      // Newest-first from the API. Collect everything newer than our mark.
      const fresh = reqs.filter(r => new Date(r.createdAt).getTime() > seenAt);
      if (fresh.length) {
        // Advance the mark to the newest request we just saw.
        const newestTs = Math.max(...fresh.map(r => new Date(r.createdAt).getTime()));
        setNotifSeenAt(newestTs);

        if (fresh.length === 1) {
          showRequestNotification(fresh[0]);
        } else {
          showRequestNotification(null, fresh.length, fresh.filter(reqIsPending).length);
        }

        // If the admin is looking at All Requests, refresh it live.
        if (document.getElementById('page-all-requests')?.classList.contains('active')) {
          loadAllRequests();
        }
      }
    } catch { /* transient; keep polling */ }
    finally { notifPollBusy = false; }
  };

  clearInterval(notifPollTimer);
  notifPollTimer = setInterval(poll, NOTIF_POLL_MS);
  // Also poll immediately when the tab regains focus, for snappier feedback.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });
  poll();
}

function showRequestNotification(req, count = 1, pendingCount = 0) {
  const container = document.getElementById('notif-container');
  if (!container) return;

  const el = document.createElement('div');
  el.className = 'notif';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;

  let title, body, coverHTML;
  if (count > 1) {
    title = `${count} new requests`;
    body  = pendingCount > 0
      ? `🕓 ${pendingCount} awaiting approval — tap to review`
      : 'Tap to review them in All Requests';
    coverHTML = '<div class="notif-cover notif-cover-multi">＋</div>';
  } else {
    const label = req.albumName
      ? `${req.artistName} — ${req.albumName}`
      : (req.artistName || 'New request');
    const pending = reqIsPending(req);
    title = pending ? 'Request needs approval' : 'New music request';
    body  = `${esc(label)} · by ${esc(req.username || 'unknown')}${pending ? ' · 🕓 tap to approve' : ''}`;
    coverHTML = req.cover
      ? `<img class="notif-cover" src="${esc(req.cover)}" alt="" data-hide-on-error>`
      : '<div class="notif-cover notif-cover-multi">🎵</div>';
  }

  el.innerHTML = `
    ${coverHTML}
    <div class="notif-body">
      <div class="notif-title">🔔 ${esc(title)}</div>
      <div class="notif-sub">${body}</div>
    </div>
    <button class="notif-close" aria-label="Dismiss">✕</button>`;

  const dismiss = () => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 300);
  };

  const goToRequests = () => {
    showPage('all-requests');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    dismiss();
  };

  el.addEventListener('click', e => {
    if (e.target.closest('.notif-close')) { e.stopPropagation(); dismiss(); return; }
    goToRequests();
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToRequests(); }
  });

  container.appendChild(el);
  // Auto-dismiss after 8s.
  setTimeout(dismiss, 8000);
}

/* ══════════════════════════════════════════════════════════════════════════
   MOOD DISCOVERY (keyless — Deezer-powered)
   A self-contained, additive module. Users describe a vibe and/or drop seed
   artists/genres; the server uses Deezer's free catalogue (related artists +
   genre charts — no LLM, no API key) to surface NEW artists. Results render as
   standard artist tiles, so the existing in-library badging and request→Lidarr
   pipeline work unchanged. Reuses the top-level helpers from above: api, esc,
   fallback, storeItem, flagInLibrary, toast.
   ══════════════════════════════════════════════════════════════════════════ */
(function moodDiscoveryModule() {
  let booted = false;

  /* Tile mirrors artistTileHTML so all the shared click/badge logic applies,
     plus an optional "start with this album" sub-line and a one-line AI reason. */
  function moodArtistTileHTML(a) {
    const name = a.name || 'Unknown Artist';
    const img  = a.image || fallback(name);
    const k    = storeItem({ type:'artist', name, artist:name, image:img, mbid:null });
    const sub  = a.album  ? `<div class="tile-sub" title="${esc(a.album)}">▶️ ${esc(a.album)}</div>` : '';
    const why  = a.reason ? `<div class="tile-reason" title="${esc(a.reason)}">${esc(a.reason)}</div>` : '';
    return `<div class="music-tile slider-item" data-artist="${esc(name)}">
      <div class="tile-img-wrap">
        <img class="tile-img" src="${esc(img)}" alt="${esc(name)}" loading="lazy" data-fallback="${esc(fallback(name))}">
        <div class="tile-overlay">
          <div class="overlay-title">${esc(name)}</div>
          <div class="overlay-actions"><button class="btn btn-primary btn-sm" data-item-key="${k}">+ Request</button></div>
        </div>
        <span class="tile-source-badge">${esc(a.source || 'Pick')}</span>
      </div>
      <div class="tile-body">
        <div class="tile-name">${esc(name)}</div>
        ${sub}
        ${why}
        <div class="tile-footer"><button class="btn btn-ghost btn-sm" data-item-key="${k}">Request</button></div>
      </div>
    </div>`;
  }

  function selectedMoods() {
    return Array.from(document.querySelectorAll('#mood-chips .mood-chip.active'))
      .map(c => c.dataset.mood);
  }

  async function runMoodDiscovery() {
    const input    = document.getElementById('mood-input');
    const out      = document.getElementById('mood-results');
    const statusEl = document.getElementById('mood-status');
    const btn      = document.getElementById('mood-go');
    if (!out) return;

    const seeds = (input?.value || '').trim();
    const moods = selectedMoods();
    if (!seeds && !moods.length) {
      toast('Add a few artists, genres, or pick a mood first', 'warning');
      input?.focus();
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.dataset.label = btn.dataset.label || btn.textContent;
      btn.textContent = '✨️ Finding…';
    }
    if (statusEl) { statusEl.classList.add('hidden'); statusEl.textContent = ''; }
    out.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div></div>';

    try {
      const data    = await api('/api/discover/mood', {
        method: 'POST',
        body: JSON.stringify({ seeds, mood: moods.join(', '), count: 12 })
      });
      const artists = data.artists || [];
      if (!artists.length) {
        // The server distinguishes "nothing found" from "you already own
        // everything we found" — the second is a real answer, not a failure.
        const why = data.note || 'Try different artists, genres, or a mood.';
        out.innerHTML = `<div class="empty-state"><div class="empty-state-icon">${data.note ? '📚' : '🎲'}</div>` +
          `<h3>${data.note ? 'Nothing new to add' : 'No picks this time'}</h3><p>${esc(why)}</p></div>`;
        return;
      }
      out.innerHTML = artists.map(moodArtistTileHTML).join('');
      // Badge anything already in the Lidarr library (artist-level), like Discover.
      flagInLibrary(out, artists, 'artist');
      if (statusEl) {
        const basis = seeds ? `“${seeds}”` : 'your mood';
        const filtered = data.filteredLibrary ? ', excluding what you already have' : '';
        statusEl.textContent = `${artists.length} new picks based on ${basis}${moods.length ? ` · ${moods.join(', ')}` : ''}${filtered}. Tap a tile to send it to Lidarr.`;
        statusEl.classList.remove('hidden');
      }
    } catch (e) {
      out.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><h3>Couldn't get recommendations</h3><p>${esc(e.message)}</p></div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || '✨️ Discover'; }
    }
  }

  /* Comma-aware artist typeahead for the mood seed box. Suggests artists for
     the term currently being typed (the text after the last comma); clicking
     one ADDS it as a seed (with a trailing ", " so you can keep stacking) —
     it does not run the discovery. Enter with a row highlighted adds that
     seed; Enter otherwise runs Discover. Reuses /api/search/suggest and the
     .search-suggest styles from the Search page. */
  function initMoodSuggest(input, goBtn) {
    const box = document.getElementById('mood-suggest');
    if (!input || !box) return;
    let timer = null, seq = 0, activeIdx = -1;

    const hide = () => { box.classList.remove('open'); box.innerHTML = ''; activeIdx = -1; };

    // The seed fragment currently being typed (after the last comma).
    const currentTerm = () => {
      const parts = input.value.split(',');
      return parts[parts.length - 1].trim();
    };

    // Replace that fragment with the picked artist and prep for the next seed.
    const addSeed = name => {
      const parts = input.value.split(',');
      parts[parts.length - 1] = name;
      input.value = parts.map(s => s.trim()).filter(Boolean).join(', ') + ', ';
      hide();
      input.focus();
    };

    const render = items => {
      if (!items.length) return hide();
      box.innerHTML = items.map(it => {
        const name = it.name || 'Unknown';
        const img  = it.thumb || it.image || fallback(name);
        return `<button type="button" class="suggest-item" data-name="${esc(name)}">
          <img class="suggest-img round" src="${esc(img)}" alt="" loading="lazy" data-fallback="${esc(fallback(name))}">
          <span class="suggest-text"><span class="suggest-name">${esc(name)}</span></span>
          <span class="suggest-cta">Add seed →</span>
        </button>`;
      }).join('');
      box.classList.add('open');
      activeIdx = -1;
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = currentTerm();
      if (q.length < 2) return hide();
      timer = setTimeout(async () => {
        const mySeq = ++seq;
        try {
          const d = await api(`/api/search/suggest?q=${encodeURIComponent(q)}&type=artist`);
          if (mySeq === seq) render(d.items || []);
        } catch { if (mySeq === seq) hide(); }
      }, 280);
    });

    input.addEventListener('keydown', e => {
      const items = box.querySelectorAll('.suggest-item');
      const open  = box.classList.contains('open') && items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!open) return;
        e.preventDefault();
        activeIdx = e.key === 'ArrowDown'
          ? (activeIdx + 1) % items.length
          : (activeIdx - 1 + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
        items[activeIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (open && activeIdx >= 0) addSeed(items[activeIdx].dataset.name || '');
        else { clearTimeout(timer); hide(); runMoodDiscovery(); }
      } else if (e.key === 'Escape') {
        hide();
      }
    });

    box.addEventListener('click', e => {
      const row = e.target.closest('.suggest-item');
      if (row) addSeed(row.dataset.name || '');
    });

    goBtn?.addEventListener('click', hide);
    document.addEventListener('click', e => {
      if (!e.target.closest('.mood-controls')) hide();
    });
  }

  function boot() {
    if (booted) return; booted = true;
    const btn   = document.getElementById('mood-go');
    const input = document.getElementById('mood-input');

    btn?.addEventListener('click', runMoodDiscovery);
    initMoodSuggest(input, btn);   // typeahead — also owns the Enter-key behaviour
    document.querySelectorAll('#mood-chips .mood-chip').forEach(chip =>
      chip.addEventListener('click', () => chip.classList.toggle('active'))
    );
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.runMoodDiscovery = runMoodDiscovery;   // exposed for manual/debug calls
})();
