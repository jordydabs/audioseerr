'use strict';
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const http      = require('http');
const https     = require('https');
const crypto    = require('crypto');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 7575;

// ── Async handler safety net ───────────────────────────────────────────────
// Express 4 forwards a SYNCHRONOUS throw to the error middleware but silently
// drops a rejected promise from an `async` handler: the client hangs forever
// and Node reports an unhandled rejection. Wrapping at registration time makes
// every route behave the same, without having to remember a try/catch in each
// of the ~50 handlers. Must run before any route is registered.
// (Handlers with 4 args are error middleware — left alone.)
function wrapHandler(h) {
  if (typeof h !== 'function' || h.length >= 4) return h;
  const wrapped = function (req, res, next) {
    try {
      const out = h.call(this, req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
      return out;
    } catch (err) { next(err); }
  };
  Object.defineProperty(wrapped, 'length', { value: h.length });
  return wrapped;
}
for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
  const original = app[method].bind(app);
  app[method] = (...args) => original(...args.map(wrapHandler));
}

// Behind a reverse proxy (the recommended deployment), Express must be told to
// trust X-Forwarded-For or rate limiting sees every client as the proxy's IP.
// Off by default (trusting the header when NOT proxied lets clients spoof IPs);
// set TRUST_PROXY=1 (hop count) in .env when fronted by a proxy.
//
// Express hands anything non-numeric straight to proxy-addr, which THROWS on a
// value that isn't an IP/CIDR/known keyword — and this runs at module load, so
// a typo (or the very plausible TRUST_PROXY=true) used to kill the process
// before listen() with a stack trace that never named the variable.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY.trim();
  const val = /^(true|false)$/i.test(tp) ? tp.toLowerCase() === 'true'
            : (isNaN(+tp) ? tp : +tp);
  try { app.set('trust proxy', val); }
  catch (e) {
    console.warn(`[AudioSeerr] ⚠️  Invalid TRUST_PROXY value "${tp}" — ignoring (${e.message}).\n` +
      `   Use a hop count (TRUST_PROXY=1), an IP/CIDR list, or "loopback".`);
  }
}

// App version — read from package.json (fallback keeps things working if the
// file ever isn't bundled next to server.js).
let APP_VERSION = '2.10.1';
try { APP_VERSION = require('./package.json').version || APP_VERSION; } catch {}

// Sent on every outbound call. MusicBrainz in particular requires an
// identifiable agent with a way to reach the operator, and will throttle or
// block a generic one; the old string was a hardcoded "AudioSeerr/2.0" that had
// long since drifted from the real version.
const USER_AGENT = `AudioSeerr/${APP_VERSION} ( https://github.com/jordydabs/audioseerr )`;

// ── Secret loading (Docker secrets friendly) ───────────────────────────────
// For every sensitive value we accept either the plain env var (e.g. JWT_SECRET)
// or a *_FILE variant (e.g. JWT_SECRET_FILE) that points at a file whose
// contents are the secret. The file form is how Docker/Swarm secrets and most
// vault integrations inject credentials at runtime, so nothing sensitive has to
// live in the image, the compose file, or process listings. The _FILE form wins
// if both are present.
function readSecret(name, fallback = '') {
  const fileVar = process.env[`${name}_FILE`];
  if (fileVar) {
    try { return fs.readFileSync(fileVar, 'utf8').trim(); }
    catch (e) { console.error(`[AudioSeerr] Could not read ${name}_FILE (${fileVar}): ${e.message}`); }
  }
  return process.env[name] ?? fallback;
}

// Placeholder secrets. A single literal comparison used to be the whole guard,
// and it silently drifted from what .env.example actually shipped — the sample
// JWT_SECRET was a *different* 36-char string, so it passed both the equality
// test and the length test and a production instance would happily boot signing
// tokens with a value published in this repo. Match the whole known sample set
// AND anything that still reads like a placeholder, so the two files can never
// drift into a false negative again.
const DEFAULT_JWT_SECRET = 'change_me_audioseerr_secret_32chars';
const DEFAULT_ADMIN_PASS = 'changeme';
const SAMPLE_JWT_SECRETS = new Set([
  DEFAULT_JWT_SECRET,
  'change_me_to_a_random_32_char_secret',   // shipped in .env.example before 2.10
  'change_me',
  'secret',
  'changeme'
]);
// Two deliberately different tests. The SUBSTRING one only looks for phrasings
// that no real secret contains ("change_me", "your_…_here"), so it catches any
// future sample without rejecting a legitimate value. The EXACT one covers the
// short throwaway passwords people actually type. Keep both narrow: a guard
// that rejects valid secrets gets disabled, and then it protects nothing.
const PLACEHOLDER_SUBSTR = /change[_\s-]?me|your[_\s-][a-z0-9_]*[_\s-]here|replace[_\s-]?me/i;
const PLACEHOLDER_EXACT  = /^(changeme|password|passw0rd|secret|admin|letmein|placeholder|example|test|xxx+|123456+)$/i;
const isPlaceholder = s => PLACEHOLDER_SUBSTR.test(s) || PLACEHOLDER_EXACT.test(s);

const JWT_SECRET = readSecret('JWT_SECRET',     DEFAULT_JWT_SECRET);
const ADMIN_USER = readSecret('ADMIN_USER',     'admin');
// Compared against when the username is unknown, so a failed login costs the
// same wall-clock time whether or not the account exists.
const BCRYPT_DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
// ADMIN_PASS only seeds the bootstrap admin (ensureAdmin), so "not provided" —
// unset, blank, whitespace-only or an empty ADMIN_PASS_FILE — is its own case,
// distinct from a weak value: it only matters while that account still has to
// be created (see checkSecrets). The sample default stands in for it so that
// outside production a missing one keeps working as it always did.
const ADMIN_PASS_RAW = readSecret('ADMIN_PASS', '');
const ADMIN_PASS_SET = ADMIN_PASS_RAW.trim() !== '';
const ADMIN_PASS     = ADMIN_PASS_SET ? ADMIN_PASS_RAW : DEFAULT_ADMIN_PASS;
// Lidarr / Last.fm from the environment are FALLBACKS — values saved from the
// app (Admin → Connections, stored in db.json) take precedence. See CONN below.
const ENV_LIDARR_URL = (readSecret('LIDARR_URL',    '')).replace(/\/$/, '');
const ENV_LIDARR_KEY = readSecret('LIDARR_API_KEY', '');
const ENV_LASTFM_KEY = readSecret('LASTFM_API_KEY', '');
const DATA_DIR   = process.env.DATA_DIR       || path.join(__dirname, 'data');
const DB_FILE    = path.join(DATA_DIR, 'db.json');
const IS_PROD    = process.env.NODE_ENV === 'production';

// Loud warnings (and a hard stop in production) for insecure defaults. These
// catch the classic "deployed to the internet with the sample secret" mistake.
// It is CALLED further down, just before ensureAdmin(): whether ADMIN_PASS
// matters depends on what is already in db.json, and the DB helpers (and the
// `let` state they use) are not initialised yet at this point in the file.
function checkSecrets() {
  // Fatal in production: a signing key or bootstrap password anyone can guess.
  const fatal = [];
  if (SAMPLE_JWT_SECRETS.has(JWT_SECRET) || isPlaceholder(JWT_SECRET) || JWT_SECRET.length < 32)
    fatal.push('JWT_SECRET — must be 32+ random chars and not a sample value. Generate one with: openssl rand -hex 32');
  if (ADMIN_PASS_SET) {
    if (ADMIN_PASS === DEFAULT_ADMIN_PASS || isPlaceholder(ADMIN_PASS))
      fatal.push('ADMIN_PASS — still a sample value.');
  } else if (!adminExists(peekDB())) {
    // Unset/blank is fatal only while the account that would use it has yet to
    // be created: it used to sail through and mint an admin with an empty
    // password hash that login rejects (and that a later fix never replaced).
    // An install that already has its admin no longer needs ADMIN_PASS — same
    // reasoning as the advisory below — so it must still boot without one.
    fatal.push(`ADMIN_PASS — empty or unset, but no "${ADMIN_USER}" account exists yet and creating it needs a password. ` +
      'Set ADMIN_PASS (or ADMIN_PASS_FILE) to one of your own; it is read only when that account is first created.' +
      (IS_PROD ? '' : ` Creating it with the sample password "${DEFAULT_ADMIN_PASS}" instead.`));
  }

  // Advisory only. ADMIN_PASS is used ONCE, at first boot, to create the admin
  // account; after that the stored bcrypt hash is what matters and the user may
  // well have changed it in-app. Refusing to boot over it would break existing
  // installs for no security gain, so a short-but-changed value only warns.
  const warn = [];
  if (ADMIN_PASS_SET && !fatal.some(f => f.startsWith('ADMIN_PASS')) && ADMIN_PASS.length < 8)
    warn.push('ADMIN_PASS is shorter than 8 characters (only affects the bootstrap admin account).');

  if (fatal.length) {
    const msg = `Insecure secret(s):\n   • ${fatal.join('\n   • ')}`;
    if (IS_PROD) {
      console.error(`\n[AudioSeerr] FATAL: ${msg}\n\n` +
        `Refusing to start in production (NODE_ENV=production) with insecure secrets.\n`);
      process.exit(1);
    }
    console.warn(`\n[AudioSeerr] ⚠️  SECURITY: ${msg}\n`);
  }
  if (warn.length) console.warn(`\n[AudioSeerr] ⚠️  ${warn.join('\n   ')}\n`);
}

// ── DB ─────────────────────────────────────────────────────────────────────
// The whole "database" is one JSON file. That is fine at home scale, but it
// makes the read path safety-critical: this used to `catch { db = <empty> }`
// for EVERY failure, so one unreadable or hand-edited-to-invalid db.json turned
// into a blank database that the very next mutating request wrote back over the
// real file — users, requests and API keys gone, nothing logged. Only a genuine
// "file does not exist yet" is legitimately empty; everything else must fail
// loudly instead of pretending the instance is brand new.
const DB_BACKUP = `${DB_FILE}.bak`;
const blankDB = () => ({ users: [], requests: [], apiKeys: [], preferences: {}, settings: {} });
let _dbLoadedOk = false;              // has a read ever succeeded? gates writes

function normaliseDB(db) {
  if (!db || typeof db !== 'object' || Array.isArray(db)) db = blankDB();
  if (!Array.isArray(db.users))    db.users    = [];
  if (!Array.isArray(db.requests)) db.requests = [];
  if (!Array.isArray(db.apiKeys))  db.apiKeys  = [];
  // preferences: per-user UI state (keyed by user id) — persisted server-side so
  // a user's choices follow them to every browser/device, not just localStorage.
  if (!db.preferences || typeof db.preferences !== 'object' || Array.isArray(db.preferences)) db.preferences = {};
  // settings: global, admin-managed config that should apply everywhere.
  if (!db.settings || typeof db.settings !== 'object' || Array.isArray(db.settings)) db.settings = {};
  return db;
}

// ── Parsed-DB cache ────────────────────────────────────────────────────────
// auth() resolves the caller against the database on EVERY request (that is
// what makes role changes and deletions take effect immediately), so the read
// path is now genuinely hot: without a cache, a dashboard polling /api/summary
// would re-read and re-parse the whole file several times a second.
//
// Validity is checked with a stat() — orders of magnitude cheaper than
// read+parse — so an external edit is still picked up. Callers mutate what they
// get back and hand it to writeDB, so reads return a CLONE; the cached object
// itself is treated as immutable. peekDB() skips the clone for read-only
// callers on the hot path.
let _dbCache = null;                  // { mtimeMs, size, data }

function statDB() {
  try { return fs.statSync(DB_FILE); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${DB_FILE}: ${e.message}`);
  }
}

// Read-only view. NEVER mutate the result — pass it to writeDB and you would be
// writing the cache back over itself. Use readDB() for anything that changes.
function peekDB() {
  const st = statDB();
  if (st && _dbCache && _dbCache.mtimeMs === st.mtimeMs && _dbCache.size === st.size) return _dbCache.data;
  return readDB();
}

function readDB() {
  const st = statDB();
  if (st && _dbCache && _dbCache.mtimeMs === st.mtimeMs && _dbCache.size === st.size) {
    return structuredClone(_dbCache.data);
  }
  let raw;
  try {
    raw = fs.readFileSync(DB_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') { _dbLoadedOk = true; return normaliseDB(blankDB()); }   // first boot
    // EACCES / EIO / EMFILE / EISDIR … — a real failure, NOT an empty database.
    throw new Error(`Cannot read ${DB_FILE}: ${e.message}`);
  }
  if (!raw.trim()) {                                    // truncated by a crash
    if (fs.existsSync(DB_BACKUP)) {
      console.error(`[AudioSeerr] ${DB_FILE} is empty — recovering from ${DB_BACKUP}`);
      raw = fs.readFileSync(DB_BACKUP, 'utf8');
    } else {
      throw new Error(`${DB_FILE} is empty — refusing to treat that as a blank database. Restore it or delete it deliberately.`);
    }
  }
  let db;
  try { db = JSON.parse(raw); }
  catch (e) { throw new Error(`${DB_FILE} is not valid JSON (${e.message}). Fix or restore it — refusing to overwrite it with an empty database.`); }
  _dbLoadedOk = true;
  db = normaliseDB(db);
  if (st) _dbCache = { mtimeMs: st.mtimeMs, size: st.size, data: db };
  return structuredClone(db);
}

function writeDB(db) {
  // Never persist a database we never managed to read — that is exactly how a
  // transient read failure used to become permanent data loss.
  if (!_dbLoadedOk) throw new Error('Refusing to write db.json: no successful read has happened yet.');
  if (!db || !Array.isArray(db.users)) throw new Error('Refusing to write a malformed db object.');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Keep one generation of history so a bad state is recoverable by hand.
  try { if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_BACKUP); } catch { /* best-effort */ }

  // Atomic + durable write: serialise to a temp file, fsync it, then rename over
  // the real one and fsync the directory. Without the fsyncs, "atomic rename"
  // only protects against a torn file — a power loss can still leave the rename
  // recorded with the data still in page cache.
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  const fd  = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(db, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, DB_FILE);
  try {
    const dir = fs.openSync(DATA_DIR, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch { /* directory fsync is unsupported on some platforms (Windows) */ }

  // Refresh the cache from what we just wrote. Storing a clone keeps the cache
  // isolated from the caller's object, which they may go on mutating.
  try {
    const st = fs.statSync(DB_FILE);
    _dbCache = { mtimeMs: st.mtimeMs, size: st.size, data: structuredClone(db) };
  } catch { _dbCache = null; }        // couldn't confirm — force a re-read next time
}

// Wrapper for route handlers: turns a failed save into a clean 500 instead of an
// unhandled promise rejection. Express 4 does not catch rejections from async
// handlers, and Node's default for an unhandled rejection is to kill the
// process — so a full disk used to crash-loop the container.
function saveDB(db, res, what = 'save') {
  try { writeDB(db); return true; }
  catch (e) {
    console.error(`[AudioSeerr] db write failed during ${what}:`, e.message);
    if (res && !res.headersSent) res.status(500).json({ error: 'Could not save — the data directory is not writable.' });
    return false;
  }
}
// Bootstrap admin. The id used to be the hardcoded string 'admin_001', while
// existence was tested by USERNAME — so changing ADMIN_USER and restarting
// deterministically produced a second user carrying the *same* id as the first.
// Every id lookup (resolveUser, PATCH/DELETE /api/users/:id, preferences) then
// resolved to whichever came first, making the new account silently operate as
// the old one and the duplicate unmanageable. Ids are unique per account now.
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}
// The single test for "does the bootstrap admin still have to be created",
// shared by ensureAdmin() and checkSecrets() so the guard and the code it
// protects can never disagree about when ADMIN_PASS is actually used.
function adminExists(db) {
  return db.users.some(u => u.username === ADMIN_USER);
}
function ensureAdmin() {
  const db = readDB();

  // Surface an install that is already in the split state described above.
  const seen = new Set(), dupes = new Set();
  for (const u of db.users) { if (seen.has(u.id)) dupes.add(u.id); seen.add(u.id); }
  if (dupes.size) {
    console.error(`[AudioSeerr] ⚠️  db.json contains users sharing an id: ${[...dupes].join(', ')}. ` +
      `Id-based lookups (edit/delete/preferences) will resolve to the first match only — fix these by hand.`);
  }

  if (!adminExists(db)) {
    let id; do { id = newId('admin'); } while (db.users.some(u => u.id === id));
    db.users.push({
      id, username: ADMIN_USER,
      passwordHash: bcrypt.hashSync(ADMIN_PASS, 10),
      role: 'admin', requestLimit: 999, canRequest: true,
      tokenVersion: 0,
      createdAt: new Date().toISOString()
    });
    writeDB(db);
    console.log(`[AudioSeerr] Admin "${ADMIN_USER}" created.`);
  }
}
checkSecrets();   // must precede ensureAdmin(): a refusal has to stop the boot before anything is written
ensureAdmin();

// One-time repair: requests created before ids were stable carry a username but
// may have a stale userId. Authorization now keys on userId ALONE (matching on
// the denormalised username let a recreated/renamed namesake inherit another
// account's requests), so the link is rebuilt once at boot rather than being
// re-guessed on every request.
(function migrateRequestOwnership() {
  try {
    const db = readDB();
    const byName = new Map();
    for (const u of db.users) {
      if (byName.has(u.username)) byName.set(u.username, null);   // ambiguous — leave alone
      else byName.set(u.username, u);
    }
    let fixed = 0;
    for (const r of db.requests) {
      if (!r.username) continue;
      if (db.users.some(u => u.id === r.userId)) continue;        // already valid
      const u = byName.get(r.username);
      if (u) { r.userId = u.id; fixed++; }
    }
    if (fixed) { writeDB(db); console.log(`[AudioSeerr] Re-linked ${fixed} request(s) to their owner by username (one-time migration).`); }
  } catch (e) {
    console.warn('[AudioSeerr] request-ownership migration skipped:', e.message);
  }
})();

// ── Runtime connections (Admin → Connections) ──────────────────────────────
// Lidarr and Last.fm credentials can be managed from inside the app (stored in
// db.json → settings, so they survive restarts and apply to every browser and
// device) OR via .env. App-saved values WIN; .env is the fallback so existing
// deployments keep working untouched. The effective values live in an in-memory
// snapshot — AudioSeerr is the only writer of db.json — refreshed at boot and
// whenever settings are saved, so hot paths never re-read the file.
const CONN = { lidarrUrl: '', lidarrKey: '', lastfmKey: '', lidarrSource: 'none', lastfmSource: 'none' };
function refreshConn(db) {
  const s = (db || readDB()).settings || {};
  const l = s.lidarr || {}, f = s.lastfm || {};
  CONN.lidarrUrl    = String(l.url    || ENV_LIDARR_URL || '').trim().replace(/\/+$/, '');
  CONN.lidarrKey    = String(l.apiKey || ENV_LIDARR_KEY || '').trim();
  CONN.lastfmKey    = String(f.apiKey || ENV_LASTFM_KEY || '').trim();
  CONN.lidarrSource = (l.url || l.apiKey) ? 'app' : ((ENV_LIDARR_URL || ENV_LIDARR_KEY) ? 'env' : 'none');
  CONN.lastfmSource = f.apiKey ? 'app' : (ENV_LASTFM_KEY ? 'env' : 'none');
}
refreshConn();
const lidarrUrl = () => CONN.lidarrUrl;
const lidarrKey = () => CONN.lidarrKey;
const lastfmKey = () => CONN.lastfmKey;

// ── Approval settings (Admin → Request Approvals) ──────────────────────────
// Overseerr-style auto-approve. Global switch lives in db.json → settings so
// it applies everywhere and survives restarts. Defaults to TRUE so existing
// installs keep their current "everything goes straight to Lidarr" behaviour
// until an admin deliberately turns it off. When off, a request is still
// auto-approved when the requester is an admin, an API-key service account,
// or a user whose account has the per-user autoApprove flag set.
function approvalCfg(db) {
  const a = (db.settings && db.settings.approvals) || {};
  return { autoApproveAll: a.autoApproveAll !== false };
}

// ── Lidarr add behaviour (Admin → Connections) ─────────────────────────────
// THE biggest Lidarr-load lever in the whole app. Every artist add tells
// Lidarr what to monitor and whether to start searching immediately:
//   monitor 'all' + search ON (the default, and the historical behaviour)
//   makes Lidarr refresh the FULL artist metadata and fire indexer searches
//   for the ENTIRE discography — for a 100+-release artist that's serious,
//   sustained CPU/network/indexer work. These settings let the admin dial
//   that down without touching Lidarr itself.
const LIDARR_MONITOR_MODES = new Set(['all', 'latest', 'future', 'none']);
function lidarrAddCfg(db) {
  const a = (db.settings && db.settings.lidarrAdd) || {};
  return {
    monitor:     LIDARR_MONITOR_MODES.has(a.monitor) ? a.monitor : 'all',
    searchOnAdd: a.searchOnAdd !== false,
    // null = "whatever Lidarr lists first", the historical behaviour. Set these
    // and a multi-root / multi-metadata-profile Lidarr stops being a lottery.
    rootFolderPath:    typeof a.rootFolderPath === 'string' && a.rootFolderPath ? a.rootFolderPath : null,
    metadataProfileId: Number.isInteger(a.metadataProfileId) ? a.metadataProfileId : null
  };
}
// Cover art is supplied by the client and later rendered in the admin's browser
// (request table + auto-popping notification popups), so it must not be able to
// carry a javascript:/data: payload or point at an internal host.
function safeImageUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.length > 500) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return u.href;
}

function isAutoApproved(db, tokenUser, dbUser) {
  if (tokenUser?.viaApiKey) return true;                 // service accounts act as admin
  if (dbUser?.role === 'admin') return true;             // admins approve themselves
  if (approvalCfg(db).autoApproveAll) return true;       // global switch
  return Boolean(dbUser?.autoApprove);                   // per-user override
}

// ── Middleware ─────────────────────────────────────────────────────────────
// NOTE on embedding: frameguard (X-Frame-Options) is disabled and the CSP
// frame-ancestors directive is set to "*", so AudioSeerr can be embedded in an
// <iframe> from ANY origin (dashboards like Organizr/Heimdall, Homepage, etc.).
// crossOriginResourcePolicy/OpenerPolicy are relaxed so embedded contexts can
// load assets without friction.
app.use(helmet({
  frameguard: false,                                   // no X-Frame-Options → embeddable
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:", "http:"],
      connectSrc: [
        "'self'",
        "https://api.deezer.com",
        "https://itunes.apple.com",
        "https://rss.applemarketingtools.com",
        "https://ws.audioscrobbler.com",
        "https://coverartarchive.org",
        "https://musicbrainz.org",
        "https://ui-avatars.com"
      ],
      objectSrc:      ["'none'"],
      manifestSrc:    ["'self'"],                      // /manifest.webmanifest
      frameAncestors: ["*"]                            // allow embedding anywhere
    }
  }
}));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check (unauthenticated, minimal) ────────────────────────────────
// Used by the Docker HEALTHCHECK and by uptime monitors. Deliberately leaks no
// configuration — just liveness + app version.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'AudioSeerr', version: APP_VERSION, uptime: Math.round(process.uptime()) });
});

const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 20,  message: { error: 'Too many login attempts.' } });
const apiLimiter   = rateLimit({ windowMs: 60*1000,    max: 300, message: { error: 'Rate limit exceeded.' } });
// Guards the "change your own password" route. The caller already holds a valid
// session, so this is just defence-in-depth against current-password guessing.
const pwLimiter    = rateLimit({ windowMs: 15*60*1000, max: 15,  message: { error: 'Too many password-change attempts. Try again in a bit.' } });

// ── Auth middleware ────────────────────────────────────────────────────────
// Accepts EITHER:
//   • a JWT (browser sessions) in `Authorization: Bearer <jwt>`, or
//   • an AudioSeerr API key (external programs) in `X-Api-Key: <key>` —
//     also accepted as `Authorization: Bearer <key>` for convenience.
// API-key callers act as a full-access service account (role: admin).
// Constant-time key comparison — a plain === leaks how many leading bytes
// matched. Cheap insurance for a value that grants full admin.
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function auth(req, res, next) {
  const bearer    = (req.headers.authorization || '').split(' ')[1];
  const candidate = req.headers['x-api-key'] || bearer;

  if (candidate) {
    let snapshot;
    try { snapshot = peekDB(); }      // read-only: no clone on the hot path
    catch (e) { console.error('[AudioSeerr]', e.message); return res.status(503).json({ error: 'Data store unavailable.' }); }
    const rec = snapshot.apiKeys.find(k => safeEqual(k.key, candidate));
    if (rec) {
      // Persist lastUsed at most once a minute. Dashboards poll with API keys
      // every few seconds; rewriting db.json on every hit is pointless churn
      // and widens the window for write collisions with real changes.
      // The mutable copy is taken ONLY when we're actually going to write.
      const lastMs = rec.lastUsed ? new Date(rec.lastUsed).getTime() : 0;
      if (!lastMs || Date.now() - lastMs > 60000) {
        try {
          const db = readDB();
          const w  = db.apiKeys.find(k => k.id === rec.id);
          if (w) { w.lastUsed = new Date().toISOString(); writeDB(db); }
        } catch { /* lastUsed is telemetry — never fail a request over it */ }
      }
      req.user = {
        id:        'apikey_' + rec.id,
        username:  rec.label || 'API Key',
        role:      'admin',
        viaApiKey: true,
        apiKeyId:  rec.id
      };
      return next();
    }
  }

  if (!bearer) return res.sendStatus(401);

  // The token's own claims are NOT authoritative. They used to be: req.user was
  // the raw JWT payload, so `role` was whatever was signed a year ago. Demoting
  // an admin or deleting an account changed nothing until the 365-day token
  // expired — the old token still satisfied adminOnly on every admin route.
  // Re-resolve identity and role from the database on every request, and honour
  // tokenVersion so a password change or role change can actually revoke.
  let decoded;
  try { decoded = jwt.verify(bearer, JWT_SECRET); }
  catch { return res.sendStatus(401); }

  let snapshot;
  try { snapshot = peekDB(); }        // read-only: no clone on the hot path
  catch (e) { console.error('[AudioSeerr]', e.message); return res.status(503).json({ error: 'Data store unavailable.' }); }

  const u = resolveUser(snapshot, decoded);
  if (!u) return res.status(401).json({ error: 'Account no longer exists — please log in again.' });
  if ((decoded.tokenVersion || 0) !== (u.tokenVersion || 0))
    return res.status(401).json({ error: 'Session revoked — please log in again.' });

  req.user = { id: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion || 0 };
  next();
}
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.sendStatus(403);
  next();
}
// Guards key-management routes so an external API key can't mint or read keys —
// only a logged-in admin (JWT session) may manage keys.
function sessionAdminOnly(req, res, next) {
  if (req.user?.viaApiKey)        return res.status(403).json({ error: 'API keys cannot manage other API keys. Use an admin login.' });
  if (req.user?.role !== 'admin') return res.sendStatus(403);
  next();
}

// Resolve the DB user for a JWT — strictly by id.
//
// This used to fall back to matching the token's USERNAME, to survive a db.json
// reset. That fallback crossed account boundaries: delete a user and recreate
// the same name (or rename an account and reuse the old name) and the deleted
// user's still-valid token resolved to the NEW account — consuming its quota
// and reading/overwriting its preferences. The db.json-reset case is handled
// once at boot by migrateRequestOwnership() instead of on every request.
function resolveUser(db, tokenUser) {
  if (!tokenUser || !tokenUser.id) return null;
  return db.users.find(u => u.id === tokenUser.id) || null;
}

// Ownership is decided by userId alone. Matching the denormalised `username`
// meant a recreated namesake — or an API key whose free-text label happened to
// equal a real username — inherited read AND delete rights over another
// account's requests.
function requestBelongsTo(r, user) {
  return Boolean(user) && r.userId === user.id;
}

// ── Daily request limits ───────────────────────────────────────────────────
// user.requestsToday counts requests made *today*; user.requestsDate remembers
// which day the counter belongs to. Whenever the counter is touched on a new
// day it is lazily reset to 0 — no cron needed, survives restarts. The "day"
// follows the server's timezone (set TZ in .env / docker-compose for resets
// at your local midnight instead of UTC).
function todayKey() { return new Date().toLocaleDateString('en-CA'); } // YYYY-MM-DD
function syncDailyCount(user) {
  const today = todayKey();
  let changed = false;
  if (user.requestsDate !== today) {
    user.requestsDate  = today;
    user.requestsToday = 0;
    changed = true;
  }
  if (typeof user.requestsToday !== 'number') { user.requestsToday = 0; changed = true; }
  return changed;
}

// ── HTTP helper (server-side fetches) ─────────────────────────────────────
// Every server-side upstream call funnels through here, so its failure modes
// are the app's failure modes. Four properties this MUST have, each of which
// was previously missing and produced a real defect:
//   1. It always settles.      No res.on('error') handler existed, so a socket
//      reset AFTER headers left the promise pending forever — and because the
//      single-flight latches (_libInflight, memo .inflight) clear in a finally
//      inside the awaited body, they stuck permanently and wedged every later
//      caller behind the same dead promise.
//   2. Bytes survive.          `raw += chunk` decoded each Buffer independently,
//      so a UTF-8 sequence split across a TCP read became U+FFFD on both sides.
//      JSON.parse still succeeded, so artist names silently corrupted — and a
//      corrupted name never matches the library, breaking in-library checks.
//   3. Credentials don't travel. Redirects re-sent opts.headers verbatim, so an
//      absolute cross-host Location received the Lidarr API key.
//   4. Responses are bounded.  An unbounded string from a hostile or broken
//      upstream is an OOM in a 256 MB container.
const HTTP_MAX_BYTES = 24 * 1024 * 1024;    // generous: a big Lidarr artist dump

function httpRequest(url, opts = {}, _hops = 0) {
  return new Promise((resolve, reject) => {
    if (_hops > 6) return reject(new Error('Too many redirects'));
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Invalid URL: ' + url)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      return reject(new Error('Unsupported protocol: ' + u.protocol));

    const lib     = u.protocol === 'https:' ? https : http;
    const timeout = opts.timeout || 25000;
    const ro  = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method:   opts.method || 'GET',
      headers:  { 'User-Agent': USER_AGENT, 'Accept':'application/json,*/*', ...(opts.headers||{}) },
      timeout
    };

    // Settle exactly once, and always clear the deadline.
    let settled = false;
    const finish = fn => v => { if (settled) return; settled = true; clearTimeout(deadline); fn(v); };
    const ok  = finish(resolve);
    const bad = finish(reject);
    // Belt and braces: `timeout` only fires on socket inactivity, which cannot
    // happen on an already-destroyed socket. This deadline covers every path.
    const deadline = setTimeout(() => {
      try { req.destroy(); } catch {}
      bad(new Error('Timeout: ' + u.hostname));
    }, timeout + 5000);

    const req = lib.request(ro, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();                                   // drain, don't leak the socket
        let next;
        try { next = new URL(res.headers.location, u); }  // resolves relative Locations, keeps the PORT
        catch { return bad(new Error('Bad redirect Location from ' + u.hostname)); }
        const headers = { ...(opts.headers || {}) };
        if (next.origin !== u.origin) {                 // never hand credentials to another origin
          for (const h of Object.keys(headers))
            if (/^(x-api-key|authorization|cookie|proxy-authorization)$/i.test(h)) delete headers[h];
        }
        return ok(httpRequest(next.href, { ...opts, method:'GET', body: undefined, headers }, _hops + 1));
      }

      const chunks = [];
      let bytes = 0;
      res.on('error', e => bad(new Error(`Connection error from ${u.hostname}: ${e.message}`)));
      res.on('aborted', () => bad(new Error('Connection aborted by ' + u.hostname)));
      res.on('data', c => {
        bytes += c.length;
        if (bytes > HTTP_MAX_BYTES) {
          try { req.destroy(); } catch {}
          return bad(new Error(`Response from ${u.hostname} exceeded ${HTTP_MAX_BYTES} bytes`));
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (settled) return;
        // Decode ONCE, across chunk boundaries — decoding per chunk splits
        // multi-byte UTF-8 sequences and silently corrupted artist names.
        // (Tried releasing each intermediate as the next was built, to shave
        // the transient peak on Lidarr's 16 MB artist dump. Measured over
        // repeated runs it was worth ~1 MB of a 65 MB spike — inside the noise,
        // because this handler is synchronous so V8 gets no chance to collect
        // mid-statement. Not worth the extra moving parts; the spike is bounded
        // instead by how OFTEN it happens, via LIB_TTL.)
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw.trim() ? JSON.parse(raw) : null; } catch { parsed = null; }
        if (res.statusCode >= 400) {
          // Keep the upstream's own words in the log, but do NOT splice an
          // arbitrary response body into an Error that ends up rendered in a
          // browser and stored in db.json.
          const detail = parsed
            ? (Array.isArray(parsed)
                ? (parsed[0]?.errorMessage || parsed[0]?.message || JSON.stringify(parsed[0]))
                : (parsed.message || parsed.error || raw.slice(0, 300)))
            : raw.slice(0, 300);
          console.warn(`[http] ${u.hostname} ${res.statusCode}: ${String(detail).slice(0, 300)}`);
          const safe = typeof detail === 'string' ? detail.replace(/[<>]/g, '').slice(0, 200) : '';
          return bad(new Error(`HTTP ${res.statusCode} from ${u.hostname}${safe ? ': ' + safe : ''}`));
        }
        // A 200 carrying non-JSON means we are not talking to what we think we
        // are (a login portal, an nginx page…). Accepting it used to produce a
        // green "Lidarr v?" badge and an empty-but-valid library cache.
        if (parsed === null && raw.trim() && !opts.allowText)
          return bad(new Error(`Non-JSON response from ${u.hostname} — is this really the API endpoint?`));
        ok(opts.allowText ? (parsed ?? raw) : parsed);
      });
    });

    req.on('timeout', () => { try { req.destroy(); } catch {} bad(new Error('Timeout: ' + u.hostname)); });
    req.on('error',   e  => bad(new Error(e.message)));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── Deezer fetch (shared, rate-limited) ─────────────────────────────────────
// EVERY Deezer call in the app goes through here. Deezer allows ~50 requests
// per 5 seconds per IP; a single Mood Discovery query fans out to dozens of
// calls, and unthrottled bursts trip the quota. Worse, Deezer reports quota
// errors as HTTP 200 with an {error:{code:4}} body — so before this helper
// existed, quota failures were completely invisible and just silently shrank
// the candidate pool ("why are my results bad sometimes?"). This helper:
//   • paces calls with a token bucket (42 per 5.2 s, concurrency-capped),
//   • detects Deezer's in-body errors, and
//   • retries ONCE after a pause on quota errors.
// It never throws — a failure returns null so every caller degrades gracefully.
// The base URL is overridable (DEEZER_BASE) so the whole pipeline can be
// integration-tested offline against a fake catalogue.
const DZ_BASE  = process.env.DEEZER_BASE || 'https://api.deezer.com';
const LFM_BASE = process.env.LASTFM_BASE || 'https://ws.audioscrobbler.com';
const IT_BASE  = process.env.ITUNES_BASE || 'https://itunes.apple.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Worst-case ARRIVAL clustering at Deezer = budget + in-flight (dispatches at a
// window's edge land together): 40 + 8 = 48, safely under Deezer's 50-per-5s.
const DZ_WINDOW_MS = 5200, DZ_WINDOW_MAX = 40, DZ_CONCURRENCY = 8;
let _dzTimes = [], _dzActive = 0;
async function _dzSlot() {
  for (;;) {
    const now = Date.now();
    _dzTimes = _dzTimes.filter(t => now - t < DZ_WINDOW_MS);
    if (_dzActive < DZ_CONCURRENCY && _dzTimes.length < DZ_WINDOW_MAX) {
      _dzTimes.push(now); _dzActive++;
      return;
    }
    await sleep(_dzActive >= DZ_CONCURRENCY ? 60 : Math.max(40, _dzTimes[0] + DZ_WINDOW_MS - now));
  }
}
// The two bare `_dzActive--` statements this replaces were correct on every
// path that SETTLED — but httpRequest could hang (see above), and then the slot
// was never given back. Eight of those and _dzSlot() spins forever on a
// condition that can no longer become true, permanently killing every
// Deezer-backed route until restart. try/finally makes the release
// unconditional and idempotent.
async function dz(pathAndQuery) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await _dzSlot();
    let released = false;
    const release = () => { if (!released) { released = true; _dzActive = Math.max(0, _dzActive - 1); } };
    try {
      const r = await httpRequest(`${DZ_BASE}${pathAndQuery}`);
      if (r && r.error) {                                  // Deezer's HTTP-200 errors
        if (r.error.code === 4 && attempt === 0) { release(); await sleep(1500); continue; }   // quota
        console.warn('[Deezer]', r.error.message || r.error.type || 'error');
        return null;
      }
      return r;
    } catch (e) {
      if (attempt === 0 && /quota|too many|429/i.test(e.message)) { release(); await sleep(1500); continue; }
      console.warn('[Deezer]', e.message);
      return null;
    } finally {
      release();
    }
  }
  return null;
}

// ── MusicBrainz (strictly ≤1 request/second, shared across all callers) ─────
// MusicBrainz publishes a hard 1 req/s limit per client and blocks agents that
// ignore it. The two call sites used to fire unthrottled, uncached and (for the
// album path) unguarded, so concurrent searches could get the instance
// rate-limited — and an MB outage turned an album search into a 500.
const MB_BASE = process.env.MB_BASE || 'https://musicbrainz.org';
const MB_CACHE_TTL = 10 * 60 * 1000;
const MB_CACHE_MAX = 200;
const _mbCache = new Map();
let _mbChain = Promise.resolve();
function mb(pathAndQuery) {
  const hit = _mbCache.get(pathAndQuery);
  if (hit && Date.now() - hit.at < MB_CACHE_TTL) return Promise.resolve(hit.data);
  _mbChain = _mbChain
    .catch(() => {})                                   // one failure must not break the queue
    .then(() => sleep(1100))                           // the 1 req/s budget, serialised
    .then(() => httpRequest(`${MB_BASE}${pathAndQuery}`, { timeout: 12000 }))
    .then(data => {
      _mbCache.set(pathAndQuery, { at: Date.now(), data });
      if (_mbCache.size > MB_CACHE_MAX) _mbCache.delete(_mbCache.keys().next().value);
      return data;
    });
  return _mbChain;
}

// ── Lidarr helpers ─────────────────────────────────────────────────────────
const lHeaders = () => ({ 'X-Api-Key': lidarrKey(), 'Content-Type':'application/json', 'Accept':'application/json' });
const lGet  = (ep, opts = {}) => httpRequest(`${lidarrUrl()}/api/v1/${ep}`, { headers: lHeaders(), ...opts });
const lPost = (ep, body) => httpRequest(`${lidarrUrl()}/api/v1/${ep}`, { method:'POST', headers: lHeaders(), body: JSON.stringify(body) });
const lPut  = (ep, body) => httpRequest(`${lidarrUrl()}/api/v1/${ep}`, { method:'PUT',  headers: lHeaders(), body: JSON.stringify(body) });
const lDel  = ep         => httpRequest(`${lidarrUrl()}/api/v1/${ep}`, { method:'DELETE', headers: lHeaders(), allowText: true });

// ── Lidarr read memo (single-flight + TTL + error backoff) ─────────────────
// Protects Lidarr from AudioSeerr-side traffic. Three properties:
//   1. TTL cache      — dashboards can poll /api/summary as fast as
//                       they like; Lidarr sees at most one fetch per TTL.
//   2. Single-flight  — concurrent callers share ONE in-progress request
//                       instead of stampeding.
//   3. Error backoff  — when Lidarr is down/slow, the failure itself is cached
//                       briefly, so a struggling Lidarr is NOT hit by a wall of
//                       instant retries (which is exactly when it hurts most).
//                       Stale data is served during backoff when we have it —
//                       but only up to staleMax old, so a real outage still
//                       surfaces as "offline" within a couple of minutes
//                       instead of being masked by stale data forever.
// The whole memo is flushed on connection changes (see refreshConn's caller).
const _lidarrMemo = new Map();   // key -> { at, data, err, errAt, inflight }
function clearLidarrMemo() { _lidarrMemo.clear(); }
async function lidarrMemoGet(key, ttl, fn, { errTtl = 15000, staleMax = 120000 } = {}) {
  const now = Date.now();
  let e = _lidarrMemo.get(key);
  if (!e) {
    e = { at: 0, data: undefined, err: null, errAt: 0, inflight: null };
    _lidarrMemo.set(key, e);
    // Bounded: the map is only cleared on a connection change, and per-limit
    // keys are caller-controlled, so it needs its own ceiling.
    if (_lidarrMemo.size > 50) _lidarrMemo.delete(_lidarrMemo.keys().next().value);
  }
  if (e.data !== undefined && now - e.at < ttl) return e.data;      // fresh hit
  if (e.err && now - e.errAt < errTtl) {                            // failing — back off
    if (e.data !== undefined && now - e.at < staleMax) return e.data;   // serve stale (capped)
    throw e.err;
  }
  if (e.inflight) return e.inflight;                                // share the fetch
  e.inflight = (async () => {
    try {
      const data = await fn();
      e.data = data; e.at = Date.now(); e.err = null;
      return data;
    } catch (err) {
      e.err = err; e.errAt = Date.now();
      if (e.data !== undefined && Date.now() - e.at < staleMax) return e.data;   // serve stale (capped)
      throw err;
    } finally {
      e.inflight = null;
    }
  })();
  return e.inflight;
}

// Cached wrappers for the cheap, frequently-polled Lidarr reads.
const STATUS_TTL = 15000;   // status/queue: ≤4 Lidarr hits/min however hard a dashboard polls
const CONFIG_TTL = 60000;   // root folders / profiles change ~never mid-session
const lidarrStatusCached = () => lidarrMemoGet('status', STATUS_TTL, () => lGet('system/status'));
// The version string is rendered straight into the sidebar badge in every
// user's browser. It comes from whatever host the Lidarr URL points at, so
// treat it as untrusted input and strip it to version-ish characters here as
// well as escaping it client-side.
const lidarrVersion = s => String(s?.version || '?').replace(/[^\w.\-+]/g, '').slice(0, 32) || '?';
const lidarrQueueCountCached = () => lidarrMemoGet('queue-count', STATUS_TTL, async () => {
  const q = await lGet('queue?page=1&pageSize=1');
  return { count: q?.totalRecords ?? (Array.isArray(q?.records) ? q.records.length : 0) };
});

async function getLidarrConfig() {
  // Memoised (60s): the request modal and every add/approval need this, and
  // the three underlying endpoints basically never change mid-session — no
  // reason to make Lidarr serve them again for every single action.
  return lidarrMemoGet('config', CONFIG_TTL, async () => {
    const [roots, qualities, metas] = await Promise.all([
      lGet('rootFolder'), lGet('qualityprofile'), lGet('metadataprofile')
    ]);
    if (!Array.isArray(roots)     || !roots.length)     throw new Error('No root folders in Lidarr');
    if (!Array.isArray(qualities) || !qualities.length) throw new Error('No quality profiles in Lidarr');
    if (!Array.isArray(metas)     || !metas.length)     throw new Error('No metadata profiles in Lidarr');
    return {
      rootFolders:      roots.map(r => ({ id: r.id, path: r.path })),
      qualityProfiles:  qualities.map(q => ({ id: q.id, name: q.name })),
      metadataProfiles: metas.map(m => ({ id: m.id, name: m.name }))
    };
  });
}

// ── Library lookup ─────────────────────────────────────────────────────────
// Returns the set of foreignArtistIds (and a normalised name set) currently in
// the Lidarr library, so results can be flagged "already in library".
//
// IMPORTANT (Lidarr load): badging Discover/Search/Mood tiles fires many
// in-library checks at once, and the backing `GET /api/v1/artist` dump is the
// single most expensive read we ever ask of Lidarr (the FULL artist list —
// multi-MB JSON for a big library that Lidarr must serialise every time).
// Protections, in order of importance:
//   • TTL cache (5 min)       — browsing costs at most one dump per 5 minutes.
//   • Stale-while-revalidate  — an expired cache is served immediately while
//                               ONE background refresh runs; badge checks never
//                               queue up behind a slow dump.
//   • Single-flight           — concurrent cold-cache callers share one fetch
//                               (no stampede).
//   • Error backoff (30s)     — if the dump fails, we do NOT retry for 30s and
//                               serve whatever we have. Without this, every
//                               badge batch would instantly re-fire the most
//                               expensive request at a Lidarr that is already
//                               struggling — a retry storm at the worst moment.
//   • Adds INSERT, not invalidate — after we add an artist we splice it into
//                               the cached sets instead of nuking the cache;
//                               an approval spree of N requests costs ZERO
//                               extra dumps (it used to cost up to N).
// Matching is done in memory against the cache.
// Sizing these against a REAL large library rather than a guess. On a 1,500-
// artist / 1.1M-track Lidarr, GET /api/v1/artist takes ~240s to first byte —
// Lidarr aggregates per-artist statistics across every track before it sends
// anything — and returns ~17 MB. The old 25s default timeout therefore missed
// by roughly 10x, so the refresh failed far more often than it succeeded and
// every library-dependent feature (in-library badges, Mood's owned-artist
// filter, For You, fulfilment tracking) silently degraded.
//
// LIB_TIMEOUT: generous enough for a very large library. Override for an
//   enormous one; it only ever applies to this one call.
// LIB_TTL: was 5 minutes, which asked a 4-minute endpoint to run 12x an hour
//   and paid the parse spike each time. Adds splice straight into the cache
//   (see addToLibCache), so a long TTL does NOT make the badges stale.
// LIB_ERR_BACKOFF: was 30s, which on a slow Lidarr meant a doomed request
//   roughly every minute, forever.
const LIB_TIMEOUT     = Math.max(30000, parseInt(process.env.LIDARR_LIBRARY_TIMEOUT_MS, 10) || 300000);
const LIB_TTL         = Math.max(60000, parseInt(process.env.LIDARR_LIBRARY_TTL_MS, 10) || 45 * 60 * 1000);
const LIB_ERR_BACKOFF = 5 * 60 * 1000;
// A cold cache must not block a page load for minutes. Start the dump, but hand
// the caller whatever we have if it has not landed in this long; it populates
// in the background and badges appear on the next render.
const LIB_COLD_WAIT   = 8000;
let _libCache    = { at: 0, valid: false, ids: new Set(), names: new Set(), list: [] };
let _libInflight = null;
let _libErrUntil = 0;

// Normalise an artist name for tolerant matching (case / "The" / accents /
// punctuation) so we can recognise library artists WITHOUT a per-name Lidarr
// metadata lookup.
function normArtist(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/^the\s+/, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

// Generation counter. invalidateLibCache() could only rebind _libCache — it had
// no way to fence a dump that was ALREADY in flight, so an admin who repointed
// AudioSeerr at a different Lidarr could have the OLD server's library land a
// moment later and repopulate the cache as authoritative. Every add then
// short-circuited to "already in library" and never reached the new Lidarr,
// while the request row was stored as delivered. The captured generation makes
// a stale fetch a no-op.
let _libGen = 0;

function refreshLibrary() {
  if (_libInflight) return _libInflight;              // share an in-progress fetch
  if (Date.now() < _libErrUntil) return Promise.resolve(_libCache);   // backing off
  const gen = _libGen;
  const startedAt = Date.now();
  _libInflight = (async () => {
    try {
      const artists = await lGet('artist', { timeout: LIB_TIMEOUT });
      // A non-array here means we did not get a Lidarr artist list (wrong URL,
      // a login portal, an HTML error page). Caching that as an empty-but-valid
      // library silently disabled every in-library badge for 5 minutes; treat
      // it as the failure it is so the error backoff engages instead.
      if (!Array.isArray(artists)) throw new Error('Lidarr /artist did not return a list');
      const ids = new Set(), names = new Set(), list = [];
      for (const a of artists) {
        if (a.foreignArtistId) ids.add(a.foreignArtistId);
        if (a.artistName) {
          names.add(normArtist(a.artistName));
          // Keep id + statistics + added: they cost nothing extra here and power
          // fulfilment tracking and the "recently added" row without a second
          // Lidarr request.
          list.push({
            name: a.artistName,
            fid:  a.foreignArtistId || null,
            id:   a.id ?? null,
            added: a.added || null,
            stats: a.statistics
              ? { trackFileCount: a.statistics.trackFileCount ?? 0,
                  trackCount:     a.statistics.trackCount ?? 0,
                  percentOfTracks: a.statistics.percentOfTracks ?? 0,
                  sizeOnDisk:     a.statistics.sizeOnDisk ?? 0 }
              : null
          });
        }
      }
      if (gen !== _libGen) return _libCache;           // connection changed under us — discard
      _libCache    = { at: Date.now(), valid: true, ids, names, list };   // empty library caches fine
      _libErrUntil = 0;
      console.log(`[Lidarr] library cached: ${list.length} artists in ${Math.round((Date.now()-startedAt)/1000)}s ` +
        `(next refresh in ${Math.round(LIB_TTL/60000)} min)`);
      return _libCache;
    } catch (e) {
      if (gen === _libGen) _libErrUntil = Date.now() + LIB_ERR_BACKOFF;
      console.warn(`[Lidarr] library fetch failed after ${Math.round((Date.now()-startedAt)/1000)}s ` +
        `(backing off ${LIB_ERR_BACKOFF/1000}s):`, e.message);
      return _libCache;                                // serve stale (or empty) data
    } finally {
      // Only clear OUR latch — clearing unconditionally would wipe a newer
      // in-flight fetch started after an invalidation and break single-flight.
      if (gen === _libGen) _libInflight = null;
    }
  })();
  return _libInflight;
}

async function getLibraryArtists() {
  const now = Date.now();
  if (_libCache.valid && now - _libCache.at < LIB_TTL) return _libCache;   // fresh
  if (_libCache.valid) { refreshLibrary(); return _libCache; }             // stale → serve + refresh in bg
  // Cold. This used to await the whole dump, which on a large library meant the
  // first page load sat there for minutes. Race it against a short wait and
  // serve what we have; the fetch continues and the next render is badged.
  const inflight = refreshLibrary();                                       // respects backoff
  return Promise.race([inflight, sleep(LIB_COLD_WAIT).then(() => _libCache)]);
}

// After WE add an artist, splice it into the cache — the cache stays truthful
// with no refetch. (Nuking here used to force a full library dump on the very
// next badge check, once per approved request.)
function addToLibCache(foreignArtistId, artistName, lidarrId) {
  if (foreignArtistId) _libCache.ids.add(foreignArtistId);
  if (artistName) {
    _libCache.names.add(normArtist(artistName));
    _libCache.list.push({ name: artistName, fid: foreignArtistId || null, id: lidarrId ?? null, added: new Date().toISOString(), stats: null });
  }
}
// Full invalidation — only for connection changes (different Lidarr server).
// Bumping the generation is what actually fences any dump already in flight.
function invalidateLibCache() {
  _libGen++;
  _libCache    = { at: 0, valid: false, ids: new Set(), names: new Set(), list: [] };
  _libInflight = null;
  _libErrUntil = 0;
  _lookupFidCache.clear();       // name→id resolutions belong to the old server
}

// Is a given artist (by foreignArtistId, falling back to a normalised name)
// already in Lidarr? Matched against the cached library only — no per-call Lidarr
// lookup, so badging a page of tiles costs at most one library fetch (shared).
async function artistInLibrary({ foreignArtistId, artistName, deep = false }) {
  if (!lidarrUrl() || !lidarrKey()) return false;
  try {
    const lib = await getLibraryArtists();
    if (foreignArtistId && lib.ids.has(foreignArtistId)) return true;
    if (artistName && lib.names.has(normArtist(artistName))) return true;
    // Alias-aware fallback (see lidarrFidForName below): resolve the name to
    // its canonical foreignArtistId and match by ID.
    if (deep && artistName) {
      const fid = await lidarrFidForName(artistName);
      if (fid && lib.ids.has(fid)) return true;
    }
    return false;
  } catch (e) {
    console.warn('[Lidarr] in-library check failed:', e.message);
    return false;
  }
}

// ── Alias-aware ("deep") name resolution ───────────────────────────────────
// Name matching alone can't recognise provider aliases — Deezer says "STS9",
// Lidarr says "Sound Tribe Sector 9", and no normalisation bridges that.
// Lidarr's own artist lookup IS alias-aware (ask it for "STS9" and it returns
// Sound Tribe Sector 9 with its ID), so for names that fail the cheap
// in-memory match we resolve name → foreignArtistId via `artist/lookup` and
// check the ID against the library. Resolutions are cached for the process
// lifetime (name→ID is stable), so each distinct name costs at most ONE
// metadata lookup ever; transient failures are NOT cached so a hiccup can't
// permanently poison a name. Deep checks are only used for user-triggered
// pages (Search / Mood — ≤18 names, concurrency-limited); Discover keeps the
// cheap name-only path so browsing never hammers the metadata server.
const _lookupFidCache = new Map();     // normArtist(name) -> foreignArtistId | null
const LOOKUP_FID_CACHE_MAX = 3000;
async function lidarrFidForName(name) {
  const key = normArtist(name);
  if (!key) return null;
  if (_lookupFidCache.has(key)) return _lookupFidCache.get(key);
  try {
    const results = await lGet(`artist/lookup?term=${encodeURIComponent(name)}`);
    const fid = (Array.isArray(results) && results[0]?.foreignArtistId) || null;
    _lookupFidCache.set(key, fid);
    if (_lookupFidCache.size > LOOKUP_FID_CACHE_MAX) _lookupFidCache.delete(_lookupFidCache.keys().next().value);
    return fid;
  } catch { return null; }             // transient failure — don't cache
}

// Lidarr's *internal* numeric artist id for an artist we already have. The
// library cache now retains it (see refreshLibrary), so album-level operations
// on an existing artist normally cost zero extra Lidarr requests.
async function lidarrArtistIdFor(foreignArtistId, artistName) {
  const lib = await getLibraryArtists();
  const key = normArtist(artistName);
  const hit = (lib.list || []).find(a =>
    (foreignArtistId && a.fid === foreignArtistId) || (key && normArtist(a.name) === key));
  if (hit?.id) return hit.id;
  // Cache predates this field (or the artist was spliced in after an add) —
  // fall back to one targeted lookup.
  try {
    const all = await lGet('artist');
    if (!Array.isArray(all)) return null;
    const m = all.find(a =>
      (foreignArtistId && a.foreignArtistId === foreignArtistId) ||
      (key && normArtist(a.artistName) === key));
    return m?.id ?? null;
  } catch { return null; }
}

// Small concurrency pool so a deep batch never stampedes the metadata server.
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) || 1 }, async () => {
    while (i < list.length) { const idx = i++; out[idx] = await fn(list[idx], idx); }
  }));
  return out;
}

// ── In-library check endpoint (used before requesting) ─────────────────────
// Accepts ?artistName= and/or ?foreignArtistId=. Resolves against the cached
// library only — deliberately does NOT do a Lidarr metadata lookup per name
// (that would hit MusicBrainz for every tile and overload Lidarr). A rare
// false-negative just means a missing badge; the request flow still detects an
// existing artist and reports "already in library".
app.get('/api/lidarr/in-library', auth, apiLimiter, async (req, res) => {
  if (!lidarrUrl() || !lidarrKey()) return res.json({ inLibrary: false, configured: false });
  const artistName      = (req.query.artistName || '').toString().trim();
  const foreignArtistId = (req.query.foreignArtistId || '').toString().trim() || null;
  const deep            = req.query.deep === '1' || req.query.deep === 'true';
  try {
    const inLibrary = await artistInLibrary({ foreignArtistId, artistName, deep });
    res.json({ inLibrary, configured: true, artistName, foreignArtistId });
  } catch (e) {
    res.status(502).json({ inLibrary: false, configured: true, error: e.message });
  }
});

// ── In-library batch check ─────────────────────────────────────────────────
// Badging a whole page (Discover/Search/Mood) in ONE request instead of one per
// tile. Does a single (single-flighted) library fetch and matches everything in
// memory. Body: { names: [...], ids: [...] } where ids are foreignArtistIds
// (exact matching, immune to name-spelling differences — used by the request
// modal's Lidarr match picker). → { results: {name:bool}, idResults: {id:bool} }
app.post('/api/lidarr/in-library-batch', auth, apiLimiter, async (req, res) => {
  if (!lidarrUrl() || !lidarrKey()) return res.json({ configured: false, results: {}, idResults: {} });
  const names = Array.isArray(req.body?.names) ? req.body.names.slice(0, 100) : [];
  const ids   = Array.isArray(req.body?.ids)   ? req.body.ids.slice(0, 100)   : [];
  const deep  = req.body?.deep === true;
  try {
    const lib = await getLibraryArtists();
    const results = {};
    for (const raw of names) {
      const n = (raw || '').toString().trim();
      if (n) results[n] = lib.names.has(normArtist(n));
    }
    // Deep pass: names the cheap match missed get resolved through Lidarr's
    // alias-aware lookup and re-checked by ID (catches "STS9" → Sound Tribe
    // Sector 9). Capped + concurrency-limited; cached names are free.
    if (deep) {
      const misses = Object.keys(results).filter(n => !results[n]).slice(0, 30);
      await mapLimit(misses, 5, async n => {
        const fid = await lidarrFidForName(n);
        if (fid && lib.ids.has(fid)) results[n] = true;
      });
    }
    const idResults = {};
    for (const raw of ids) {
      const s = (raw || '').toString().trim();
      if (s) idResults[s] = lib.ids.has(s);
    }
    res.json({ configured: true, results, idResults });
  } catch (e) {
    res.status(502).json({ configured: true, results: {}, idResults: {}, error: e.message });
  }
});

// ── Lidarr search endpoints (for modal picker) ─────────────────────────────
app.get('/api/lidarr/search-artist', auth, apiLimiter, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  if (!lidarrUrl() || !lidarrKey()) return res.status(503).json({ error: 'Lidarr not configured' });
  try {
    const results = await lGet(`artist/lookup?term=${encodeURIComponent(q)}`);
    res.json((results||[]).slice(0,8).map(a => ({
      foreignArtistId: a.foreignArtistId,
      artistName:      a.artistName,
      overview:        (a.overview||'').slice(0,120),
      images:          a.images||[],
      genres:          a.genres||[],
      status:          a.status||''
    })));
  } catch(e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/lidarr/search-album', auth, apiLimiter, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  if (!lidarrUrl() || !lidarrKey()) return res.status(503).json({ error: 'Lidarr not configured' });
  try {
    const results = await lGet(`album/lookup?term=${encodeURIComponent(q)}`);
    res.json((results||[]).slice(0,8).map(a => ({
      foreignAlbumId: a.foreignAlbumId,
      title:          a.title,
      releaseDate:    a.releaseDate||'',
      images:         a.images||[],
      overview:       (a.overview||'').slice(0,120),
      artist: {
        foreignArtistId: a.artist?.foreignArtistId,
        artistName:      a.artist?.artistName||''
      }
    })));
  } catch(e) { res.status(503).json({ error: e.message }); }
});

// ── Trigger a Lidarr search command ────────────────────────────────────────
// Kicks off an ArtistSearch / AlbumSearch in Lidarr for an already-added entity.
// Accepts { lidarrId, type } (type: 'artist' | 'album'). Adds via /api/requests
// already auto-search on add, so this is for re-searching or for API/dashboard
// consumers that want explicit control.
// adminOnly: this fires real indexer searches in Lidarr and bypasses every
// control the admin configured around requesting — canRequest, the per-user
// daily limit and the approval queue. Nothing in the UI calls it (it exists for
// dashboards/scripts), so gating it costs nothing.
app.post('/api/lidarr/search', auth, adminOnly, apiLimiter, async (req, res) => {
  if (!lidarrUrl() || !lidarrKey()) return res.status(503).json({ error: 'Lidarr not configured' });
  const lidarrId = parseInt(req.body?.lidarrId);
  const type     = (req.body?.type || 'artist').toString().toLowerCase();
  if (!lidarrId) return res.status(400).json({ error: 'lidarrId is required.' });
  try {
    const command = type === 'album'
      ? { name: 'AlbumSearch',  albumIds: [lidarrId] }
      : { name: 'ArtistSearch', artistId: lidarrId };
    const r = await lPost('command', command);
    res.json({ ok: true, commandId: r?.id ?? null, status: r?.status ?? 'queued' });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ── Lidarr download queue (browse via API / dashboard) ─────────────────────
// One call returns what Lidarr is currently downloading, trimmed to the fields a
// dashboard tile needs. Accepts an API key or a session.
app.get('/api/lidarr/queue', auth, apiLimiter, async (req, res) => {
  if (!lidarrUrl() || !lidarrKey()) return res.status(503).json({ error: 'Lidarr not configured' });
  // Clamp BOTH ends. Only the upper bound was clamped, so ?limit=-999999
  // survived `|| 20`, went to Lidarr as a negative pageSize, and — because the
  // value is part of the memo key — let any caller mint unbounded cache entries
  // at 300 requests/minute, each one bypassing the memo and hitting Lidarr.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  try {
    // Memoised per limit (15s) — the includeArtist/includeAlbum expansion makes
    // this one of Lidarr's pricier queries, so dashboard polling shouldn't
    // re-run it more than a few times a minute.
    const q = await lidarrMemoGet(`queue-detail:${limit}`, STATUS_TTL,
      () => lGet(`queue?page=1&pageSize=${limit}&includeArtist=true&includeAlbum=true`));
    const records = Array.isArray(q?.records) ? q.records : (Array.isArray(q) ? q : []);
    res.json({
      total: q?.totalRecords ?? records.length,
      records: records.map(r => ({
        id:         r.id,
        artist:     r.artist?.artistName || r.artist?.name || null,
        album:      r.album?.title || r.title || null,
        status:     r.status || null,
        trackedDownloadState:  r.trackedDownloadState || null,
        // Passed through so a stalled or failed grab is visible in the UI
        // instead of looking like it is still progressing.
        trackedDownloadStatus: r.trackedDownloadStatus || null,
        errorMessage:          r.errorMessage || null,
        statusMessages:        Array.isArray(r.statusMessages)
          ? r.statusMessages.slice(0, 3).map(m => ({ title: m.title || '', messages: (m.messages || []).slice(0, 3) }))
          : [],
        indexer:    r.indexer || null,
        protocol:   r.protocol || null,
        size:       r.size || 0,
        sizeleft:   r.sizeleft || 0,
        progress:   r.size ? Math.round(((r.size - (r.sizeleft || 0)) / r.size) * 100) : null,
        timeleft:   r.timeleft || null
      }))
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Remove a stuck/failed grab from Lidarr's queue. Admin-only: this cancels a
// real download.
app.delete('/api/lidarr/queue/:id', auth, adminOnly, apiLimiter, async (req, res) => {
  if (!lidarrUrl() || !lidarrKey()) return res.status(503).json({ error: 'Lidarr not configured' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid queue id.' });
  const blocklist = req.query.blocklist === '1';
  try {
    await lDel(`queue/${id}?removeFromClient=true&blocklist=${blocklist}`);
    clearLidarrMemo();                       // the queue memo is now stale
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ── sendToLidarr ───────────────────────────────────────────────────────────
// Artist requests add the artist. ALBUM requests now add/monitor that album.
//
// Previously every request — artist or album — was turned into an artist add,
// and the album path had a dead end that made the app's single most common use
// case impossible: if the artist was already in the library, the add
// short-circuited to "exists" and returned before doing anything. So "I own
// OK Computer, now get me In Rainbows" resulted in NOTHING happening in Lidarr
// while the request was recorded as delivered. The album id needed to fix that
// was already being collected by the modal, posted, stored, and then used only
// to look the artist back up.
async function sendToLidarr(type, artistName, albumName, qualityProfileId, foreignArtistId, foreignAlbumId) {
  if (!lidarrUrl() || !lidarrKey())
    return { ok: false, status: 'not_configured', message: 'Lidarr not linked — add it in Admin → Connections (or .env)' };

  try {
    const cfg    = await getLidarrConfig();
    const addCfg = lidarrAddCfg(readDB());
    // Honour the admin's chosen root folder / metadata profile instead of
    // always taking whatever Lidarr happened to list first — on a multi-root
    // setup every add silently landed in root #0.
    const rootPath = (addCfg.rootFolderPath && cfg.rootFolders.find(r => r.path === addCfg.rootFolderPath)?.path)
                   || cfg.rootFolders[0].path;
    // Only accept a quality profile that actually exists — the id comes
    // straight from the request body and was never validated.
    const qualId   = (cfg.qualityProfiles.find(q => q.id === parseInt(qualityProfileId, 10))?.id)
                   || cfg.qualityProfiles[0].id;
    const metaId   = (addCfg.metadataProfileId && cfg.metadataProfiles.find(m => m.id === addCfg.metadataProfileId)?.id)
                   || cfg.metadataProfiles[0].id;
    const qualName = (cfg.qualityProfiles.find(q => q.id === qualId) || cfg.qualityProfiles[0]).name;
    console.log(`[Lidarr] root="${rootPath}" quality="${qualName}"(${qualId})`);

    // ── Resolve the artist to add ─────────────────────────────────────────
    // Start from whatever identifying info we have; for album requests, look
    // up the album to discover its artist.
    let artistHit = null;

    let albumHit = null;

    // 1) If an album was requested, resolve it to its artist.
    if (type === 'album') {
      if (foreignAlbumId) {
        try {
          // encodeURIComponent: these ids arrive from the request body and are
          // spliced into a URL — an unencoded '&' or '#' would silently truncate
          // or rewrite the query.
          const lk = await lGet(`album/lookup?term=lidarr:${encodeURIComponent(foreignAlbumId)}`);
          albumHit = Array.isArray(lk) ? lk[0] : null;
        } catch(e) { console.warn('[Lidarr] foreignAlbumId lookup failed:', e.message); }
      }
      if (!albumHit) {
        const searchTerm = albumName ? `${artistName||''} ${albumName}`.trim() : artistName;
        console.log(`[Lidarr] Album→artist lookup: "${searchTerm}"`);
        const results = await lGet(`album/lookup?term=${encodeURIComponent(searchTerm)}`);
        albumHit = Array.isArray(results) ? results[0] : null;
      }
      if (albumHit?.artist) {
        artistHit = albumHit.artist;
        console.log(`[Lidarr] Album "${albumHit.title}" → artist "${artistHit.artistName}" fid=${artistHit.foreignArtistId}`);
      }
      // Carry through any artist id the album exposed.
      if (!foreignArtistId && artistHit?.foreignArtistId) foreignArtistId = artistHit.foreignArtistId;
    }

    // 2) If we still don't have an artist, look one up directly.
    if (!artistHit) {
      if (foreignArtistId) {
        try {
          const lk = await lGet(`artist/lookup?term=lidarr:${encodeURIComponent(foreignArtistId)}`);
          artistHit = Array.isArray(lk) ? lk[0] : null;
        } catch(e) { console.warn('[Lidarr] foreignArtistId lookup failed:', e.message); }
      }
      if (!artistHit && artistName) {
        console.log(`[Lidarr] Artist lookup: "${artistName}"`);
        const results = await lGet(`artist/lookup?term=${encodeURIComponent(artistName)}`);
        artistHit = Array.isArray(results) ? results[0] : null;
      }
    }

    if (!artistHit || !artistHit.foreignArtistId) {
      return { ok: false, status: 'not_found',
               message: `Artist "${artistName || albumName}" not found in Lidarr` };
    }
    if (!artistHit.artistName) artistHit.artistName = artistName;

    const artistExists = await artistInLibrary({
      foreignArtistId: artistHit.foreignArtistId, artistName: artistHit.artistName
    });

    // ══ ALBUM REQUEST ═════════════════════════════════════════════════════
    // Monitor the specific album the user asked for, whether or not we already
    // have the artist. This is the case the old artist-only path could not
    // serve at all.
    if (type === 'album' && albumHit?.foreignAlbumId) {
      const albumTitle = albumHit.title || albumName || 'album';
      try {
        if (artistExists) {
          // Artist is already in Lidarr — find the album under it and monitor it.
          const lidarrArtistId = await lidarrArtistIdFor(artistHit.foreignArtistId, artistHit.artistName);
          if (!lidarrArtistId) throw new Error('Artist is in Lidarr but its id could not be resolved');
          const albums = await lGet(`album?artistId=${encodeURIComponent(lidarrArtistId)}`);
          const found  = Array.isArray(albums)
            ? albums.find(a => a.foreignAlbumId === albumHit.foreignAlbumId)
            : null;
          if (!found) {
            // Lidarr knows the artist but not this release yet (metadata lag or
            // a metadata profile that filters it out).
            return { ok: false, status: 'not_found',
                     message: `"${albumTitle}" is not listed under "${artistHit.artistName}" in Lidarr — check its Metadata Profile (it may exclude this release type).` };
          }
          if (found.monitored && (found.statistics?.trackFileCount ?? 0) > 0) {
            return { ok: true, status: 'exists', lidarrType: 'album', lidarrId: found.id,
                     message: `"${albumTitle}" is already in your Lidarr library` };
          }
          await lPut(`album/${encodeURIComponent(found.id)}`, { ...found, monitored: true });
          if (addCfg.searchOnAdd) {
            await lPost('command', { name: 'AlbumSearch', albumIds: [found.id] }).catch(e =>
              console.warn('[Lidarr] AlbumSearch command failed:', e.message));
          }
          console.log(`[Lidarr] Monitoring existing album "${albumTitle}" (id=${found.id}) searchOnAdd=${addCfg.searchOnAdd}`);
          return { ok: true, status: 'sent', lidarrType: 'album', lidarrId: found.id,
                   message: `"${albumTitle}" is now monitored in Lidarr` };
        }

        // Artist is NOT in Lidarr — POST the album with the artist nested. This
        // is exactly what Lidarr's own "add album" does: it creates the artist
        // unmonitored and monitors only this release, so a single-album request
        // doesn't drag in a 100-release discography.
        const created = await lPost('album', {
          ...albumHit,
          monitored: true,
          profileId: qualId,
          artist: {
            ...artistHit,
            qualityProfileId:  qualId,
            metadataProfileId: metaId,
            rootFolderPath:    rootPath,
            monitored:         true,
            addOptions: { monitor: 'none', searchForMissingAlbums: false }
          },
          addOptions: { searchForNewAlbum: addCfg.searchOnAdd }
        });
        addToLibCache(artistHit.foreignArtistId, artistHit.artistName, created?.artist?.id ?? null);
        console.log(`[Lidarr] Added album "${albumTitle}" by "${artistHit.artistName}" searchOnAdd=${addCfg.searchOnAdd}`);
        return { ok: true, status: 'sent', lidarrType: 'album', lidarrId: created?.id ?? null,
                 message: `"${albumTitle}" by ${artistHit.artistName} added to Lidarr` };
      } catch (e) {
        if (/already|duplicate|409/i.test(e.message)) {
          return { ok: true, status: 'exists', lidarrType: 'album',
                   message: `"${albumTitle}" is already in your Lidarr library` };
        }
        console.warn('[Lidarr] album add failed, falling back to artist add:', e.message);
        // fall through to the artist path below — better a monitored artist
        // than a failed request
      }
    }

    // ══ ARTIST REQUEST (and album fallback) ═══════════════════════════════
    console.log(`[Lidarr] Adding artist: "${artistHit.artistName}" fid=${artistHit.foreignArtistId}`);

    // ── Already in library? Don't try to re-add ───────────────────────────
    if (artistExists) {
      return { ok: true, status: 'exists',
               message: `"${artistHit.artistName}" already in Lidarr`, lidarrType: 'artist' };
    }

    // ── Add the artist ────────────────────────────────────────────────────
    // Post the FULL artist object returned by Lidarr's lookup (it carries the
    // metadata fields Lidarr expects — artistType, images, links, etc.) with the
    // add fields merged in. `monitor` belongs inside addOptions, not at the top
    // level. This is the canonical Servarr add and avoids creating malformed
    // artist entries. Monitoring scope + search-on-add come from the admin's
    // "Lidarr add behaviour" settings (see lidarrAddCfg) — that's what decides
    // how much work Lidarr does after each add.
    try {
      const created = await lPost('artist', {
        ...artistHit,
        qualityProfileId:  qualId,
        metadataProfileId: metaId,
        rootFolderPath:    rootPath,
        monitored:         addCfg.monitor !== 'none',
        addOptions: { monitor: addCfg.monitor, searchForMissingAlbums: addCfg.searchOnAdd }
      });
      // Splice into the library cache (no refetch — see addToLibCache).
      addToLibCache(artistHit.foreignArtistId, artistHit.artistName, created?.id ?? null);
      console.log(`[Lidarr] Added with monitor="${addCfg.monitor}" searchOnAdd=${addCfg.searchOnAdd}`);
      return { ok: true, status: 'sent', message: `"${artistHit.artistName}" added to Lidarr`,
               lidarrId: created?.id ?? null, lidarrType: 'artist' };
    } catch(e) {
      if (/already|duplicate|409/i.test(e.message)) {
        addToLibCache(artistHit.foreignArtistId, artistHit.artistName);
        return { ok: true, status: 'exists', message: `"${artistHit.artistName}" already in Lidarr`, lidarrType: 'artist' };
      }
      throw e;
    }
  } catch(e) {
    console.error('[Lidarr] Fatal:', e.message);
    return { ok: false, status: 'error', message: e.message };
  }
}

// ── Outbound notifications ─────────────────────────────────────────────────
// Until now the only notification was an in-app poll that ran for admins only,
// every 20s, and ONLY while a tab was open and visible — so a pending request
// could sit unseen for days, and a regular user was never told their request
// had been approved or rejected at all.
//
// Targets are admin-configured and stored in db.json → settings.notifications.
// Everything goes through the existing httpRequest(), so this adds no npm
// dependency: Discord, ntfy, Gotify and a generic JSON webhook are just
// different body/header shapes. Delivery is fire-and-forget — a dead webhook
// must never delay or fail the request that triggered it.
const NOTIFY_EVENTS = ['request.created', 'request.pending', 'request.approved',
                       'request.rejected', 'request.available', 'request.failed'];
const NOTIFY_TYPES  = ['discord', 'ntfy', 'gotify', 'webhook'];

function notifyCfg(db) {
  const n = (db.settings && db.settings.notifications) || {};
  const targets = Array.isArray(n.targets) ? n.targets : [];
  return { targets };
}

function notifyText(event, r) {
  const what  = r.albumName ? `${r.artistName} — ${r.albumName}` : r.artistName;
  const who   = r.username ? ` (requested by ${r.username})` : '';
  switch (event) {
    case 'request.created':   return { title: '🎵 New request sent to Lidarr', body: `${what}${who}` };
    case 'request.pending':   return { title: '🕓 Request awaiting approval',  body: `${what}${who}` };
    case 'request.approved':  return { title: '✅ Request approved',           body: `${what}${who}` };
    case 'request.rejected':  return { title: '🚫 Request rejected',           body: `${what}${who}${r.lidarrMessage ? ` — ${r.lidarrMessage}` : ''}` };
    case 'request.available': return { title: '🎉 Now available',             body: `${what}${who} has finished downloading.` };
    case 'request.failed':    return { title: '⚠️ Request could not be sent',  body: `${what}${who} — ${r.lidarrMessage || 'Lidarr error'}` };
    default:                  return { title: 'AudioSeerr', body: what };
  }
}

async function deliverNotification(target, event, request) {
  const { title, body } = notifyText(event, request);
  const url = target.url;
  try {
    if (target.type === 'discord') {
      await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        allowText: true,                        // Discord answers 204 with an empty body
        body: JSON.stringify({
          username: 'AudioSeerr',
          embeds: [{
            title, description: body, color: 0xf5a623,
            timestamp: new Date().toISOString(),
            ...(request.cover ? { thumbnail: { url: request.cover } } : {})
          }]
        })
      });
    } else if (target.type === 'ntfy') {
      await httpRequest(url, {
        method: 'POST',
        allowText: true,                        // ntfy replies with a plain-text receipt
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          // Header values must be latin-1 safe — strip the emoji from the title.
          'Title': title.replace(/[^\x20-\x7E]/g, '').trim() || 'AudioSeerr',
          'Tags':  event.replace('.', '_')
        },
        body
      });
    } else if (target.type === 'gotify') {
      await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        allowText: true,
        body: JSON.stringify({ title, message: body, priority: 5 })
      });
    } else {                                    // generic JSON webhook
      await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        allowText: true,
        body: JSON.stringify({ event, title, body, request, app: 'AudioSeerr', version: APP_VERSION })
      });
    }
    return true;
  } catch (e) {
    console.warn(`[Notify] ${target.type} "${target.label || target.id}" failed:`, e.message);
    return false;
  }
}

function notify(event, request) {
  if (!NOTIFY_EVENTS.includes(event)) return;
  let targets;
  try { targets = notifyCfg(readDB()).targets; }
  catch { return; }                             // never let notification config break a request
  for (const t of targets) {
    if (!t || t.enabled === false || !t.url) continue;
    if (Array.isArray(t.events) && t.events.length && !t.events.includes(event)) continue;
    deliverNotification(t, event, request).catch(() => {});   // fire and forget
  }
}

// ── Auth routes ────────────────────────────────────────────────────────────
// Session lifetime. Kept at the historical 365 days by default so nobody is
// logged out by an upgrade, but configurable now that revocation actually works
// (tokenVersion) — SESSION_DAYS=30 is a much better posture for an instance
// reachable from outside the LAN.
const SESSION_DAYS = Math.max(1, Math.min(parseInt(process.env.SESSION_DAYS, 10) || 365, 365));
function signSession(u) {
  return jwt.sign(
    { id: u.id, username: u.username, role: u.role, tokenVersion: u.tokenVersion || 0 },
    JWT_SECRET,
    { expiresIn: `${SESSION_DAYS}d` }
  );
}

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const db   = readDB();
  const user = db.users.find(u => u.username === username);
  // Always run a bcrypt compare, even for an unknown username, so response
  // timing doesn't reveal which accounts exist.
  const hash = user ? user.passwordHash : BCRYPT_DUMMY_HASH;
  const ok   = await bcrypt.compare(password, hash);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid credentials.' });
  res.json({ token: signSession(user), role: user.role, username: user.username });
});

app.post('/api/auth/refresh', auth, apiLimiter, (req, res) => {
  // API keys are not browser sessions and must not be upgradable into a
  // (non-expiring, full-admin) session JWT — that would let a leaked key bypass
  // sessionAdminOnly and start managing keys/users. Reject them here.
  if (req.user.viaApiKey)
    return res.status(403).json({ error: 'API keys cannot be refreshed into a session.' });
  // Re-read rather than re-signing the caller's own claims: a refresh must not
  // be able to roll a demoted or revoked session forward forever.
  const u = resolveUser(readDB(), req.user);
  if (!u) return res.sendStatus(401);
  res.json({ token: signSession(u), role: u.role, username: u.username });
});

// ── Who am I ───────────────────────────────────────────────────────────────
// Everything the shell needs about the current user in one call: display name,
// effective role, and today's request usage against their limit. The UI used to
// read identity from localStorage (written at login and never refreshed), so a
// role change or a quota update was invisible until the next sign-in.
app.get('/api/me', auth, apiLimiter, (req, res) => {
  if (req.user.viaApiKey) {
    return res.json({ username: req.user.username, role: 'admin', viaApiKey: true,
                      canRequest: true, requestsToday: 0, requestLimit: null, unlimited: true });
  }
  const db = readDB();
  const u  = resolveUser(db, req.user);
  if (!u) return res.sendStatus(401);
  syncDailyCount(u);                       // in-memory only — a read must not write
  res.json({
    username:      u.username,
    role:          u.role,
    viaApiKey:     false,
    canRequest:    u.canRequest !== false,
    autoApprove:   Boolean(u.autoApprove),
    requestsToday: u.requestsToday || 0,
    requestLimit:  dailyLimitOf(u),
    unlimited:     false
  });
});

// ── Change your own password ───────────────────────────────────────────────
// Any logged-in user (admin or not) can change THEIR OWN password here by
// proving they know the current one. This is the self-service path — admins
// resetting OTHER users' passwords still go through PATCH /api/users/:id.
// API-key service accounts have no password, so they're rejected.
app.post('/api/auth/change-password', auth, pwLimiter, async (req, res) => {
  if (req.user.viaApiKey)
    return res.status(403).json({ error: 'API keys have no password to change.' });

  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'Current and new password are both required.' });
  if (String(newPassword).length < 4)
    return res.status(400).json({ error: 'New password must be at least 4 characters.' });

  const pre     = readDB();
  const preUser = resolveUser(pre, req.user);
  if (!preUser) return res.status(404).json({ error: 'User not found — please log out and log back in.' });

  if (!await bcrypt.compare(currentPassword, preUser.passwordHash))
    return res.status(403).json({ error: 'Current password is incorrect.' });
  if (await bcrypt.compare(String(newPassword), preUser.passwordHash))
    return res.status(400).json({ error: 'New password must be different from the current one.' });

  const newHash = await bcrypt.hash(String(newPassword), 10);

  // Apply to a FRESH read — the awaits above take real time, and writing the
  // stale snapshot back would clobber anything saved meanwhile.
  const db   = readDB();
  const user = resolveUser(db, req.user);
  if (!user) return res.status(404).json({ error: 'User not found — please log out and log back in.' });
  user.passwordHash      = newHash;
  user.passwordChangedAt = new Date().toISOString();
  // Changing your password now REVOKES every other session. Previously nothing
  // read passwordChangedAt and there was no token denylist, so a user who
  // suspected their token had been stolen had no way to kill it — a year-long
  // token stayed valid no matter what they changed.
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  if (!saveDB(db, res, 'password change')) return;
  console.log(`[AudioSeerr] Password changed for "${user.username}" — other sessions revoked.`);
  // Hand this session a fresh token so the caller isn't logged out by their own
  // change; every other device must sign in again.
  res.json({ ok: true, token: signSession(user) });
});

// ── Lidarr status / profiles ───────────────────────────────────────────────
// Status is served from the 15s memo (see lidarrStatusCached) — the sidebar
// badge, page loads, and dashboards can all ask as often as they like without
// Lidarr seeing more than a few requests a minute.
app.get('/api/lidarr/status', auth, apiLimiter, async (req, res) => {
  if (!lidarrUrl() || !lidarrKey()) return res.json({ connected: false, reason: 'Not linked — add Lidarr in Admin → Connections (or .env)' });
  try {
    const s = await lidarrStatusCached();
    res.json({ connected: true, version: lidarrVersion(s) });
  } catch(e) {
    // The raw error names the internal Lidarr host and port. That is useful to
    // an admin fixing the connection and useless-but-informative to everyone
    // else, so only admins get the detail.
    res.json({ connected: false, reason: req.user.role === 'admin' ? e.message : 'Lidarr is unreachable right now.' });
  }
});

app.get('/api/lidarr/profiles', auth, async (req, res) => {
  if (!lidarrUrl() || !lidarrKey()) return res.status(503).json({ error: 'Lidarr not configured' });
  try { res.json(await getLidarrConfig()); }
  catch(e) { res.status(503).json({ error: e.message }); }
});

// ── Dashboard summary (one-shot panel feed for Organizr / Homepage / etc.) ──
// Authenticates with an AudioSeerr API key (X-Api-Key) or an admin/user JWT.
// Returns everything a dashboard tile needs in a single call: app version,
// live Lidarr connection state, request counts, and the most recent requests —
// so the panel doesn't have to stitch together /lidarr/status + /requests.

// Normalised approval state for ANY request, including legacy rows created
// before 2.6 (which have no approvalStatus — those were all auto-approved).
function approvalOf(r) {
  if (r.approvalStatus)      return r.approvalStatus;   // approved | pending | rejected
  if (r.status === 'pending')  return 'pending';
  if (r.status === 'rejected') return 'rejected';
  return 'approved';
}

// ── Fulfilment sweep ("did I actually get it?") ────────────────────────────
// Nothing ever wrote request.status after the approval decision, so a request
// read "✅ Sent to Lidarr" forever — whether the album landed an hour later or
// the indexer never found it. For an Overseerr-alike that is THE question.
//
// This costs Lidarr nothing extra: the 5-minute full-library dump already runs
// for in-library badging, and it now retains each artist's `statistics`. Album
// rows need one cheap per-artist album query, so they are batched and capped.
// The sweep is lazy (triggered by request reads) and throttled, so an idle
// instance does no work at all.
const SWEEP_INTERVAL = 5 * 60 * 1000;
let _lastSweepAt = 0;
let _sweepInflight = null;

async function sweepFulfilment() {
  if (!lidarrUrl() || !lidarrKey()) return;
  if (_sweepInflight) return _sweepInflight;
  if (Date.now() - _lastSweepAt < SWEEP_INTERVAL) return;
  _sweepInflight = (async () => {
    try {
      const db = readDB();
      const open = db.requests.filter(r => r.status === 'sent' && !r.availableAt);
      if (!open.length) return;

      const lib = await getLibraryArtists();
      if (!lib.valid) return;                       // Lidarr unreachable — try later

      const byFid  = new Map();
      const byName = new Map();
      for (const a of (lib.list || [])) {
        if (a.fid)  byFid.set(a.fid, a);
        if (a.name) byName.set(normArtist(a.name), a);
      }

      // One album query per distinct artist that has album-type requests open.
      const albumRows = open.filter(r => r.type === 'album' && r.foreignAlbumId);
      const artistIds = [...new Set(albumRows
        .map(r => (r.foreignArtistId && byFid.get(r.foreignArtistId)?.id) || byName.get(normArtist(r.artistName))?.id)
        .filter(Boolean))].slice(0, 20);            // bounded: never a fan-out storm
      const albumsByArtist = new Map();
      await mapLimit(artistIds, 3, async id => {
        try {
          const list = await lGet(`album?artistId=${encodeURIComponent(id)}`);
          if (Array.isArray(list)) albumsByArtist.set(id, list);
        } catch { /* leave it for the next sweep */ }
      });

      const nowIso = new Date().toISOString();
      const became = [];
      for (const r of open) {
        const art = (r.foreignArtistId && byFid.get(r.foreignArtistId)) || byName.get(normArtist(r.artistName));
        if (!art) continue;

        let done = false;
        if (r.type === 'album' && r.foreignAlbumId && art.id && albumsByArtist.has(art.id)) {
          const al = albumsByArtist.get(art.id).find(a => a.foreignAlbumId === r.foreignAlbumId);
          done = Boolean(al && (al.statistics?.trackFileCount ?? 0) > 0 &&
                         (al.statistics?.percentOfTracks ?? 0) >= 99);
        } else if (art.stats) {
          // Artist request: "available" once Lidarr holds files for it. Anything
          // partial is reported as such rather than being silently called done.
          done = (art.stats.trackFileCount ?? 0) > 0 && (art.stats.percentOfTracks ?? 0) >= 99;
          if (!done && (art.stats.trackFileCount ?? 0) > 0 && r.status !== 'partial') {
            r.status = 'partial';
            r.lidarrMessage = `Downloading — ${Math.round(art.stats.percentOfTracks || 0)}% of tracks present`;
            r.updatedAt = nowIso;
          }
        }

        if (done) {
          r.status        = 'available';
          r.availableAt   = nowIso;
          r.updatedAt     = nowIso;
          r.lidarrMessage = 'Available in your library';
          became.push(r);
        }
      }

      // Re-read + re-apply so the sweep can't clobber concurrent edits.
      if (became.length || open.some(r => r.status === 'partial')) {
        const fresh = readDB();
        const byId  = new Map(fresh.requests.map(r => [r.id, r]));
        for (const r of open) {
          const t = byId.get(r.id);
          if (!t || t.status !== 'sent') continue;   // changed under us — leave alone
          if (r.status === 'available' || r.status === 'partial') {
            t.status = r.status; t.availableAt = r.availableAt ?? null;
            t.lidarrMessage = r.lidarrMessage; t.updatedAt = r.updatedAt;
          }
        }
        writeDB(fresh);
      }
      for (const r of became) notify('request.available', r);
      if (became.length) console.log(`[Sweep] ${became.length} request(s) became available.`);
      pruneRequests();
    } catch (e) {
      console.warn('[Sweep] fulfilment check failed:', e.message);
    } finally {
      _lastSweepAt   = Date.now();
      _sweepInflight = null;
    }
  })();
  return _sweepInflight;
}

// Fire-and-forget trigger used by the request read routes.
function maybeSweep() { sweepFulfilment().catch(() => {}); }

// ── Retention ──────────────────────────────────────────────────────────────
// db.requests only ever grew — the sole removal path was a manual per-row
// delete — while EVERY authenticated call re-parses and re-serialises the whole
// file. Opt-in (both limits default to off), and only settled rows are ever
// removed: anything pending or still downloading is untouchable.
function retentionCfg(db) {
  const r = (db.settings && db.settings.retention) || {};
  const days = parseInt(r.keepDays, 10);
  const max  = parseInt(r.keepMax, 10);
  return {
    keepDays: Number.isFinite(days) && days > 0 ? days : 0,   // 0 = keep forever
    keepMax:  Number.isFinite(max)  && max  > 0 ? max  : 0
  };
}
function pruneRequests() {
  try {
    const db  = readDB();
    const cfg = retentionCfg(db);
    if (!cfg.keepDays && !cfg.keepMax) return;

    const settled = r => ['available', 'exists', 'rejected'].includes(r.status) && approvalOf(r) !== 'pending';
    const before  = db.requests.length;
    let keep = db.requests;

    if (cfg.keepDays) {
      const cutoff = Date.now() - cfg.keepDays * 86400000;
      keep = keep.filter(r => !settled(r) || new Date(r.updatedAt || r.createdAt).getTime() >= cutoff);
    }
    if (cfg.keepMax && keep.length > cfg.keepMax) {
      const sorted = keep.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const keepSet = new Set(sorted.slice(0, cfg.keepMax).map(r => r.id));
      keep = keep.filter(r => keepSet.has(r.id) || !settled(r));   // never prune unsettled rows
    }
    if (keep.length === before) return;
    db.requests = keep;
    writeDB(db);
    console.log(`[Retention] pruned ${before - keep.length} settled request(s).`);
  } catch (e) {
    console.warn('[Retention] prune skipped:', e.message);
  }
}

// One counting rule shared by /api/summary and /api/requests/stats so the
// Admin page and every dashboard always agree.
//   approved = auto-approved or admin-approved (regardless of Lidarr outcome)
//   ok       = approved AND Lidarr accepted it (sent/exists)
//   problem  = approved but Lidarr delivery failed (error/not_found/not_configured)
// Invariants: total = approved + pending + rejected;  approved = ok + problem.
function requestCounts(db) {
  const okStatuses = new Set(['sent', 'exists', 'available', 'partial']);
  const today      = todayKey();
  const c = { total: db.requests.length, approved: 0, pending: 0, rejected: 0,
              ok: 0, problem: 0, available: 0, today: 0 };
  for (const r of db.requests) {
    const a = approvalOf(r);
    if      (a === 'pending')  c.pending++;
    else if (a === 'rejected') c.rejected++;
    else {
      c.approved++;
      if (okStatuses.has(r.status)) c.ok++; else c.problem++;
      if (r.status === 'available' || r.status === 'exists') c.available++;
    }
    if (r.createdAt && new Date(r.createdAt).toLocaleDateString('en-CA') === today) c.today++;
  }
  return c;
}
app.get('/api/summary', auth, apiLimiter, async (req, res) => {
  const db = readDB();

  // Live Lidarr connection (mirrors /api/lidarr/status). Served from the 15s
  // memo — a dashboard polling /api/summary every few seconds costs Lidarr at
  // most 4 status + 4 queue requests per minute, and NOTHING while a failure
  // is being backed off.
  let lidarr;
  let queue = null;
  if (!lidarrUrl() || !lidarrKey()) {
    lidarr = { connected: false, version: null, reason: 'Not linked — add Lidarr in Admin → Connections (or .env)' };
  } else {
    try {
      const s = await lidarrStatusCached();
      lidarr = { connected: true, version: lidarrVersion(s), reason: null };
      // Best-effort queue snapshot — never let it fail the whole summary.
      try { queue = await lidarrQueueCountCached(); } catch { queue = null; }
    } catch (e) {
      lidarr = { connected: false, version: null,
                 reason: req.user.role === 'admin' ? e.message : 'Lidarr is unreachable right now.' };
    }
  }

  // Scope to the caller. This route is documented as "session or key", but the
  // handler had no role branch at all — so ANY logged-in user could read every
  // other user's request history, their usernames (filterRequests matches
  // `search` against username, making it an enumeration oracle) and the account
  // and API-key counts. Admins and API keys still see the whole instance.
  const isAdmin = req.user.role === 'admin';
  const me      = resolveUser(db, req.user);
  const scope   = isAdmin ? db.requests : db.requests.filter(r => requestBelongsTo(r, me));

  // Request tallies — same counting rule as /api/requests/stats (see
  // requestCounts above), so dashboards and the Admin page always agree.
  const counts = requestCounts({ requests: scope });

  const recent = filterRequests(scope, {
      search: req.query.search,
      status: req.query.status,
      type:   req.query.type,
      limit:  Math.min(parseInt(req.query.limit, 10) || 10, 100)   // was uncapped
    })
    .map(r => ({
      id:             r.id,
      type:           r.type,
      artistName:     r.artistName,
      albumName:      r.albumName,
      cover:          r.cover,
      status:         r.status,
      approvalStatus: approvalOf(r),        // normalised — legacy rows read 'approved'
      username:       r.username,
      createdAt:      r.createdAt
    }));

  res.json({
    app:      'AudioSeerr',
    version:  APP_VERSION,
    scope:    isAdmin ? 'all' : 'mine',      // tells a consumer what it is looking at
    lidarr,
    queue,
    requests: counts,
    // Instance-wide account/key totals are admin-only facts.
    ...(isAdmin ? { users: db.users.length, apiKeys: db.apiKeys.length } : {}),
    recent
  });
});

// ── Last.fm discover (server-side — API key stays private) ─────────────────
app.get('/api/discover/lastfm', auth, apiLimiter, async (req, res) => {
  if (!lastfmKey()) return res.json({ artists: [], tracks: [] });
  async function safe(label, fn) {
    try { const r = await fn(); console.log(`[LastFM][${label}] OK`); return r; }
    catch(e) { console.warn(`[LastFM][${label}] FAILED: ${e.message}`); return null; }
  }
  // Go through LFM_BASE (like every other Last.fm call) rather than a hardcoded
  // host, and URL-encode the key instead of splicing it into a template.
  const chart = method => {
    const qs = new URLSearchParams({ method, api_key: lastfmKey(), format: 'json', limit: '20' });
    return httpRequest(`${LFM_BASE}/2.0/?${qs}`);
  };
  return res.json(await discoverCached('lastfm', req, async () => {
  const [a, t] = await Promise.all([
    safe('artists', () => chart('chart.gettopartists')),
    safe('tracks',  () => chart('chart.gettoptracks'))
  ]);
  const artists = (a?.artists?.artist||[]).map(x => {
    const img = x.image?.find(i => i.size === 'extralarge')?.['#text'] || null;
    return { name: x.name, image: (img && !img.includes('2a96cbd8b46e442fc41c2b86b821562f')) ? img : null, source: 'Last.fm' };
  });
  const tracks = (t?.tracks?.track||[]).map(x => ({
    title: x.name, artist: x.artist?.name||'', cover: null, source: 'Last.fm'
  }));
  return { artists, tracks };
  }));
});

/* ── Top artists of all time ───────────────────────────────────────────────
   Last.fm exposes no "all-time top artists" endpoint — chart.gettopartists is a
   single global *current* chart (the same one that powers Trending Artists), so
   re-sorting it by listeners would just reshuffle this week's chart, not give an
   all-time ranking. Instead we use a curated list of artists that are durably
   among the most-played of all time, and resolve cover art for each via Deezer
   search. This is stable, needs no API key, and won't duplicate the Trending
   section.

   The list is deliberately much longer than one screenful and is served a page
   at a time, so the ↻ Refresh button walks through the whole roster instead of
   showing the same 25 names forever. Artwork is memoised per NAME (see
   deezerArtistImage), so paging back and forth costs nothing upstream.
   Edit ALLTIME_ARTISTS to taste — order is the display order. */
const ALLTIME_ARTISTS = [
  // Rock & classic
  'The Beatles', 'Queen', 'Pink Floyd', 'Led Zeppelin', 'The Rolling Stones',
  'David Bowie', 'The Who', 'Fleetwood Mac', 'AC/DC', 'Bob Dylan',
  'Bruce Springsteen', 'The Doors', 'Jimi Hendrix', 'Eagles', 'Neil Young',
  'The Beach Boys', 'Creedence Clearwater Revival', 'Tom Petty', 'Van Halen', 'Aerosmith',
  'Rush', 'Genesis', 'Dire Straits', 'Talking Heads', 'The Velvet Underground',
  // Metal & hard rock
  'Metallica', 'Black Sabbath', 'Iron Maiden', 'Slayer', 'Megadeth',
  'Tool', 'System of a Down', 'Rammstein', 'Slipknot', 'Pantera',
  // Alternative & indie
  'Nirvana', 'Radiohead', 'Pearl Jam', 'Red Hot Chili Peppers', 'The Smiths',
  'Joy Division', 'The Cure', 'Pixies', 'R.E.M.', 'Oasis',
  'Arctic Monkeys', 'The Strokes', 'Foo Fighters', 'Muse', 'Blur',
  'Sonic Youth', 'Depeche Mode', 'New Order', 'Beck', 'Björk',
  // Pop
  'Michael Jackson', 'Madonna', 'Elvis Presley', 'Prince', 'Whitney Houston',
  'Mariah Carey', 'Beyoncé', 'Taylor Swift', 'Rihanna', 'Lady Gaga',
  'Adele', 'Coldplay', 'ABBA', 'Elton John', 'Billy Joel',
  'George Michael', 'Cher', 'Britney Spears', 'Justin Timberlake', 'Amy Winehouse',
  // Hip-hop & R&B
  'Eminem', 'Kendrick Lamar', 'Kanye West', 'Drake', 'Jay-Z',
  'Tupac Shakur', 'The Notorious B.I.G.', 'Nas', 'OutKast', 'A Tribe Called Quest',
  'Wu-Tang Clan', 'Dr. Dre', 'Snoop Dogg', 'Lauryn Hill', 'Missy Elliott',
  // Soul, funk & jazz
  'Stevie Wonder', 'Marvin Gaye', 'Aretha Franklin', 'James Brown', 'Ray Charles',
  'Otis Redding', 'Sam Cooke', 'Curtis Mayfield', 'Al Green', 'Nina Simone',
  'Miles Davis', 'John Coltrane', 'Ella Fitzgerald', 'Louis Armstrong', 'Billie Holiday',
  'Frank Sinatra', 'Nat King Cole', 'Herbie Hancock', 'Duke Ellington', 'Charles Mingus',
  // Electronic
  'Daft Punk', 'The Prodigy', 'The Chemical Brothers', 'Aphex Twin', 'Massive Attack',
  'Portishead', 'Kraftwerk', 'Moby', 'Fatboy Slim', 'Underworld',
  // Reggae, country & folk
  'Bob Marley', 'Johnny Cash', 'Willie Nelson', 'Dolly Parton', 'Hank Williams',
  'Simon & Garfunkel', 'Joni Mitchell', 'Leonard Cohen', 'Nick Drake', 'Townes Van Zandt'
];

const ALLTIME_PAGE = 25;
const ALLTIME_PAGES = Math.ceil(ALLTIME_ARTISTS.length / ALLTIME_PAGE);
// Cached per page. Artwork lookups are the expensive part and are already
// memoised per name, so a page revisit is free even after this expires.
const _allTimeCache = new Map();          // page -> { at, artists }
const ALLTIME_TTL   = 6 * 3600 * 1000;

app.get('/api/discover/alltime', auth, apiLimiter, async (req, res) => {
  const raw  = parseInt(req.query.page, 10);
  const page = Number.isFinite(raw) ? ((raw % ALLTIME_PAGES) + ALLTIME_PAGES) % ALLTIME_PAGES : 0;

  const hit = _allTimeCache.get(page);
  if (hit && Date.now() - hit.at < ALLTIME_TTL)
    return res.json({ artists: hit.artists, page, pages: ALLTIME_PAGES, total: ALLTIME_ARTISTS.length, cached: true });

  const slice = ALLTIME_ARTISTS.slice(page * ALLTIME_PAGE, page * ALLTIME_PAGE + ALLTIME_PAGE);
  // Concurrency-limited rather than a bare Promise.all: 25 unthrottled Deezer
  // searches in one burst is exactly the pattern that trips the quota.
  const artists = await mapLimit(slice, 6, async name => {
    const image = await deezerArtistImage(name);   // memoised per name
    return { name, image, source: 'All-Time' };
  });

  _allTimeCache.set(page, { at: Date.now(), artists });
  res.json({ artists, page, pages: ALLTIME_PAGES, total: ALLTIME_ARTISTS.length, cached: false });
});


/* ── Discover chart cache ──────────────────────────────────────────────────
   The trending rows are global charts that move at most once a day, yet every
   page load re-fetched all three upstreams. A short TTL keeps the page current
   while collapsing N browsers into one upstream call — and ?fresh=1 (the UI's
   Refresh button) bypasses it so a manual refresh is genuinely fresh.
   Each payload carries fetchedAt so the client can show its age and decide
   when to re-poll. */
const DISCOVER_TTL = 10 * 60 * 1000;
const _discoverCache = new Map();          // key -> { at, data, inflight }

async function discoverCached(key, req, fn) {
  const fresh = req.query.fresh === '1';
  let e = _discoverCache.get(key);
  if (!fresh && e && e.data && Date.now() - e.at < DISCOVER_TTL) return { ...e.data, fetchedAt: new Date(e.at).toISOString(), cached: true };
  if (e && e.inflight) return e.inflight;   // single-flight: no stampede on a cold cache
  if (!e) { e = { at: 0, data: null, inflight: null }; _discoverCache.set(key, e); }
  e.inflight = (async () => {
    try {
      const data = await fn();
      e.data = data; e.at = Date.now();
      return { ...data, fetchedAt: new Date(e.at).toISOString(), cached: false };
    } finally { e.inflight = null; }
  })();
  return e.inflight;
}

/* ── Deezer chart proxy ────────────────────────────────────────────────── */
app.get('/api/discover/deezer', auth, apiLimiter, async (req, res) => {
  try {
    res.json(await discoverCached('deezer', req, async () => {
      const [artists, albums, tracks] = await Promise.all([
        dz('/chart/0/artists?limit=25'),
        dz('/chart/0/albums?limit=25'),
        dz('/chart/0/tracks?limit=25')
      ]);
      return { artists: artists?.data || [], albums: albums?.data || [], tracks: tracks?.data || [] };
    }));
  } catch(e) {
    console.warn('[Deezer proxy]', e.message);
    res.json({ artists:[], albums:[], tracks:[] });
  }
});

/* ── "For You" — recommendations seeded from the Lidarr library ────────────
   The personal layer of Discover: pick a handful of random artists the user
   actually has in Lidarr, fetch similar artists for each, and serve
   "Because you have <seed>" rows — with anything already in the library
   filtered out. Upstream cost is tightly controlled:
     • Per-seed similar-artist lookups are memoised for 12h (relationships
       barely change) with an LRU-ish cap, so re-shuffles and repeat visits
       reuse them.
     • The assembled response is cached 30 min and shared by every user and
       device — a fresh page load usually costs ZERO upstream calls.
     • Cold cost is ~2 Deezer calls per seed (search + related), paced by the
       shared dz() token bucket; Last.fm getsimilar is the fallback when
       Deezer doesn't know the artist (images then fall back client-side).
   Nothing here touches Lidarr beyond the already-cached library list. */
const SIM_TTL       = 12 * 3600 * 1000;   // per-seed similar-artist memo
const SIM_CACHE_MAX = 200;
const _simCache     = new Map();          // normArtist(seed) -> { at, items }
const FORYOU_TTL    = 30 * 60 * 1000;     // assembled-rows cache
const FORYOU_SEEDS  = 4;                  // rows per load
const FORYOU_ROW_N  = 12;                 // recommendations per row
let _forYouCache    = { at: 0, rows: null };
let _forYouGen = 0;
function clearForYouCache() { _forYouGen++; _forYouCache = { at: 0, rows: null }; _simCache.clear(); }

// NEG_TTL: a lookup that came back empty gets a SHORT life, not the full 12h.
// dz() returns null for both "no such artist" and "Deezer was unreachable", so
// an empty result used to be indistinguishable from an outage — and caching it
// for 12 hours meant one bad minute silently emptied "For You" for half a day.
const SIM_NEG_TTL = 5 * 60 * 1000;

async function similarForSeed(seedName) {
  const key = normArtist(seedName);
  if (!key) return [];
  const hit = _simCache.get(key);
  if (hit && Date.now() - hit.at < (hit.items.length ? SIM_TTL : SIM_NEG_TTL)) return hit.items;

  let items = [];
  // Deezer first: keyless AND ships artwork, which the tiles want.
  const sr    = await dz(`/search/artist?q=${encodeURIComponent(seedName)}&limit=3`);
  const found = (sr?.data || []).find(a => normArtist(a.name) === key) || (sr?.data || [])[0] || null;
  if (found && found.id) {
    const rel = await dz(`/artist/${encodeURIComponent(found.id)}/related?limit=35`);
    items = (rel?.data || []).map(dzArtist).map(a => ({
      id: a.id, name: a.name, image: a.image || null, fans: a.fans ?? null, source: 'Deezer'
    }));
  }
  // Last.fm fallback — names only (its images are placeholder stars, so the
  // client's avatar fallback handles artwork).
  if (!items.length && lastfmKey()) {
    const r = await lfm('artist.getsimilar', { artist: seedName, limit: 35, autocorrect: 1 });
    items = (r?.similarartists?.artist || [])
      .filter(x => x && x.name)
      .map(x => ({ id: null, name: x.name, image: null, fans: null, source: 'Last.fm' }));
  }
  _simCache.set(key, { at: Date.now(), items });
  if (_simCache.size > SIM_CACHE_MAX) _simCache.delete(_simCache.keys().next().value);
  return items;
}

app.get('/api/discover/for-you', auth, apiLimiter, async (req, res) => {
  if (!lidarrUrl() || !lidarrKey()) return res.json({ rows: [], reason: 'not_configured' });

  const gen  = _forYouGen;
  const lib  = await getLibraryArtists();
  const pool = (lib.list || []).filter(a => a && a.name);
  if (!pool.length) {
    return res.json({ rows: [], reason: lib.valid ? 'library_empty' : 'library_unavailable' });
  }

  // shuffle=1 forces a fresh random seed pick; plain loads share the cached
  // rows for 30 min. (Per-seed lookups stay memoised either way, so even a
  // shuffle mostly reuses upstream data once seeds start repeating.)
  const shuffle = req.query.shuffle === '1';
  if (!shuffle && _forYouCache.rows && Date.now() - _forYouCache.at < FORYOU_TTL) {
    return res.json({ rows: _forYouCache.rows, cached: true });
  }

  const seeds = [...pool].sort(() => Math.random() - 0.5).slice(0, FORYOU_SEEDS);
  const perSeed = await Promise.all(seeds.map(s => similarForSeed(s.name).catch(() => [])));

  const rows = [];
  const seen = new Set();                       // dedupe across rows
  seeds.forEach((s, i) => {
    const items = [];
    for (const a of perSeed[i]) {
      const k = normArtist(a.name);
      if (!k || seen.has(k) || lib.names.has(k)) continue;    // skip dupes + library
      seen.add(k);
      items.push(a);
      if (items.length >= FORYOU_ROW_N) break;
    }
    // A row with 1-2 tiles looks broken — only keep rows with substance.
    if (items.length >= 3) rows.push({ seed: s.name, items });
  });

  // Same generation fence as the library cache: rows assembled from the OLD
  // Lidarr's library must not land in the cache after a connection change.
  if (gen === _forYouGen) _forYouCache = { at: Date.now(), rows };   // shuffles refresh the shared cache too
  res.json({ rows, cached: false });
});

/* ── Apple Music RSS proxy ─────────────────────────────────────────────────
   Apple serves exactly ONE album feed today: most-played. A previous attempt at
   a separate "New & Upcoming" row asked for a `most-recent` feed, which does
   not exist and 404s — so choosing iTunes on that row rendered nothing at all.
   `new-releases`, `coming-soon`, `top-albums` and the legacy
   itunes.apple.com/us/rss/newreleases endpoint are all gone too (verified: 404
   / 400).

   What the feed DOES carry is a releaseDate on every entry, so a real
   "new and upcoming" view is derivable: pull the largest page Apple allows
   (100 — 200 returns nothing) and sort by release date. That surfaces both the
   last few weeks AND genuinely unreleased albums, since charting pre-orders
   carry a future date.

   Host note: rss.applemarketingtools.com now 301s to rss.marketingtools.apple.com.
   Requesting the current host directly saves a redirect on every call. */
const APPLE_RSS = process.env.APPLE_RSS_BASE || 'https://rss.marketingtools.apple.com';
const APPLE_STOREFRONT = (process.env.APPLE_STOREFRONT || 'us').toLowerCase().replace(/[^a-z]/g, '') || 'us';
const APPLE_MAX = 100;                       // Apple's ceiling; 200 returns an empty feed

async function appleAlbums(limit = 25) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 25, 1), APPLE_MAX);
  try {
    const feed = await httpRequest(`${APPLE_RSS}/api/v2/${APPLE_STOREFRONT}/music/most-played/${n}/albums.json`);
    const results = feed?.feed?.results;
    if (!Array.isArray(results)) throw new Error('unexpected feed shape');
    return results;
  } catch (e) {
    console.warn('[Apple RSS]', e.message);
    return [];
  }
}

app.get('/api/discover/itunes', auth, apiLimiter, async (req, res) => {
  res.json(await discoverCached('itunes', req, async () => ({ results: await appleAlbums(25) })));
});

// New & upcoming: the same chart re-sorted by release date, newest first.
app.get('/api/discover/itunes-new', auth, apiLimiter, async (req, res) => {
  res.json(await discoverCached('itunes-new', req, async () => {
  const all = await appleAlbums(APPLE_MAX);
  const today = new Date().toISOString().slice(0, 10);
  const results = all
    .filter(a => a && a.releaseDate)
    .sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate)))
    .slice(0, 25)
    // upcoming = not out yet. Lets the UI say so instead of showing a future
    // year with no explanation.
    .map(a => ({ ...a, upcoming: String(a.releaseDate) > today }));
  return { results };
  }));
});

/* ── Mood Discovery (multi-source: Deezer + iTunes + Last.fm) ──────────────
   Given any mix of seed ARTISTS, GENRES and a MOOD, surface NEW artists that
   fit *all* the terms — searching every catalogue we can, with no required
   setup. Deezer and iTunes are keyless; Last.fm is used too when a key is set
   (it adds a second similarity graph and precise tag-based mood matching).

   Signals, and how they combine:
     • SIMILARITY (artists): three graphs — Deezer "fans also like" (+ a hop
       deeper), Last.fm artist.getSimilar, and Deezer PLAYLIST CO-OCCURRENCE
       (fan-made "<artist>" playlists are curated similarity, and they're
       keyless — so seed similarity stays strong even without Last.fm).
     • MOOD: real curation, not chart-toppers — Deezer playlists found for the
       mood ("deep focus", "sad songs", …) plus Last.fm mood tags. Moods also
       pull in their typical genres, but only as *anchors* for finding
       candidates and as WEAK matching evidence — a mood never acts as a hard
       genre filter (that's what used to bury good picks under chart names).
     • GENRE: typed genres filter and re-rank. Each finalist's real genre is
       read from its Deezer releases, cross-checked against Last.fm tags,
       iTunes' primaryGenreName and playlist membership; the more catalogues
       agree, the higher it ranks. Genres and moods are matched INDEPENDENTLY —
       a pick should satisfy every dimension the user asked for.
     • DISCOVERY: popularity (Deezer fans) biases toward lesser-known acts,
       more so for chill/experimental/dark moods, less for party. Genre-chart
       anchors expand from DEEPER chart cuts, not the top-3 megastars (related-
       of-megastars is just more megastars).
   Unrecognised typed tokens degrade gracefully: an artist Deezer can't confirm
   is still tried on Last.fm AND becomes a free-text style term (tag + playlist
   search), so "late-night ambient" works even though it's nobody's name.
   Candidates are joined across catalogues by a normalised name. Every source
   is optional and isolated; all Deezer traffic flows through the shared
   rate-limited dz() so a big fan-out can't trip the API quota and silently
   degrade results. Bounded by explicit caps; runs in parallel waves; cached. */

// Deezer genre ids we recognise.
const DZ_GENRE = { 132:'Pop',116:'Hip-Hop',152:'Rock',113:'Dance',165:'R&B',
  85:'Alternative',106:'Electronic',466:'Folk',144:'Reggae',129:'Jazz',
  98:'Classical',173:'Soundtracks',464:'Metal',169:'Soul & Funk',153:'Blues',197:'Latin' };

// Typed genre word/synonym → genre id (whole-word match; specific entries first).
// Micro-genres map to the nearest Deezer family — the typed word ALSO flows
// through verbatim as a Last.fm tag and a playlist search, which carry the
// precision the coarse family can't.
const GENRE_WORDS = [
  ['hip hop',116],['hip-hop',116],['hiphop',116],['rap',116],['trap',116],['drill',116],['grime',116],
  ['phonk',116],['boom bap',116],['memphis rap',116],['uk rap',116],['cloud rap',116],['horrorcore',116],['crunk',116],
  ['r&b',165],['rnb',165],['r and b',165],['rhythm and blues',165],
  ['soul',169],['funk',169],['motown',169],['disco',169],
  ['neo-soul',169],['neo soul',169],['afrobeat',169],['gospel',169],['boogie',169],
  ['edm',113],['house',113],['techno',113],['dance',113],['club',113],['trance',113],['garage',113],
  ['dubstep',113],['drum and bass',113],['drum n bass',113],['dnb',113],['d&b',113],['jungle',113],
  ['breakbeat',113],['breaks',113],['uk garage',113],['2 step',113],['hardstyle',113],['future bass',113],
  ['big room',113],['eurodance',113],['acid house',113],
  ['electronic',106],['electronica',106],['electro',106],['idm',106],['ambient',106],['synth',106],['synthwave',106],['downtempo',106],['trip hop',106],['trip-hop',106],
  ['vaporwave',106],['chillwave',106],['breakcore',106],['glitch',106],['drone',106],['dark ambient',106],
  ['berlin school',106],['chiptune',106],['witch house',106],['minimal techno',106],['microhouse',106],['dub techno',106],
  ['metal',464],['heavy metal',464],['metalcore',464],['death metal',464],['doom',464],['thrash',464],
  ['black metal',464],['power metal',464],['progressive metal',464],['prog metal',464],['sludge',464],
  ['stoner rock',464],['stoner',464],['djent',464],['grindcore',464],['nu metal',464],['nu-metal',464],
  ['deathcore',464],['symphonic metal',464],['folk metal',464],
  ['folk',466],['acoustic',466],['singer-songwriter',466],['americana',466],['bluegrass',466],['country',466],
  ['indie folk',466],['freak folk',466],['alt-country',466],['alt country',466],['appalachian',466],
  ['reggae',144],['ska',144],['dub',144],['dancehall',144],
  ['roots reggae',144],['rocksteady',144],['ska punk',144],
  ['jazz',129],['bebop',129],['swing',129],['fusion',129],
  ['smooth jazz',129],['free jazz',129],['jazz fusion',129],['nu jazz',129],['big band',129],
  ['classical',98],['orchestral',98],['piano',98],['opera',98],['baroque',98],
  ['chamber music',98],['symphony',98],['neoclassical',98],
  ['soundtrack',173],['score',173],['ost',173],['film',173],['game',173],['cinematic',173],
  ['video game',173],['vgm',173],['anime',173],
  ['blues',153],['delta blues',153],['chicago blues',153],
  ['latin',197],['latino',197],['reggaeton',197],['salsa',197],['bossa',197],['bossa nova',197],
  ['cumbia',197],['bachata',197],['tango',197],['samba',197],['mpb',197],['mariachi',197],
  ['indie',85],['alternative',85],['alt rock',85],['alt-rock',85],['punk',85],['post-punk',85],['post punk',85],['grunge',85],['shoegaze',85],['emo',85],['hardcore',85],['noise',85],['post-rock',85],['post rock',85],['math rock',85],
  ['garage rock',85],['surf rock',85],['krautrock',85],['space rock',85],['art rock',85],['new wave',85],['no wave',85],
  ['industrial',85],['ebm',85],['goth',85],['gothic',85],['darkwave',85],['post-hardcore',85],['post hardcore',85],
  ['screamo',85],['pop punk',85],['pop-punk',85],['midwest emo',85],['slowcore',85],['sadcore',85],['jangle pop',85],
  ['rock',152],['classic rock',152],['hard rock',152],['psych',152],['psychedelic',152],['prog',152],['blues rock',152],
  ['pop',132],['synthpop',132],['dream pop',132],['indie pop',132],['k-pop',132],['kpop',132],['hyperpop',132],
  ['afrobeats',132],['city pop',132],['j-pop',132],['jpop',132],['bedroom pop',132],['europop',132],['art pop',132],['electropop',132]
];

// Album genre_ids that count as a "match" for a requested genre (family-expanded).
const GENRE_FAMILY = {
  152:[152,85,464], 464:[464,152], 85:[85,152,466],
  132:[132,113], 113:[113,106], 106:[106,113],
  116:[116], 165:[165,169], 169:[169,165,129], 129:[129,169],
  98:[98,173], 466:[466,85], 144:[144], 153:[153,129,169],
  197:[197], 173:[173,98]
};

// Typed mood synonyms → mood key (chips also send these keys directly).
const MOOD_WORDS = {
  chill:'chill',chilled:'chill',relaxed:'chill',mellow:'chill',calm:'chill',lofi:'chill','lo-fi':'chill',dreamy:'chill',ethereal:'chill',
  energetic:'energetic',upbeat:'energetic',hype:'energetic',hyped:'energetic',workout:'energetic',pumped:'energetic',
  happy:'energetic',uplifting:'energetic',aggressive:'energetic',angry:'energetic',intense:'energetic',driving:'energetic',
  focus:'focus',study:'focus',studying:'focus',concentration:'focus',instrumental:'focus',
  melancholic:'melancholic',melancholy:'melancholic',sad:'melancholic',moody:'melancholic',somber:'melancholic',rainy:'melancholic',
  nostalgic:'melancholic',wistful:'melancholic',bittersweet:'melancholic',heartbreak:'melancholic',
  party:'party',dancey:'party',festive:'party',groovy:'party',dancing:'party',
  experimental:'experimental',weird:'experimental',avant:'experimental','avant-garde':'experimental',abstract:'experimental',leftfield:'experimental',trippy:'experimental',spacey:'experimental',
  romantic:'romantic',romance:'romantic',love:'romantic',sensual:'romantic',valentine:'romantic',
  dark:'dark',brooding:'dark',sinister:'dark',haunting:'dark',eerie:'dark',ominous:'dark'
};
// Mood → Deezer genre ids. Used ONLY for anchoring genre/mood-only queries and
// as WEAK matching evidence — never as a hard filter (moods aren't genres).
const MOOD_GENRES = {
  chill:[165,169,129,106], energetic:[152,113,464,132], focus:[98,129,106],
  melancholic:[85,466,153,129], party:[113,132,116,197], experimental:[106,85,464,129],
  romantic:[165,132,129,169], dark:[464,106,85]
};
// Mood → Last.fm tags (Last.fm tags capture moods directly — this is a precise
// mood signal). Typed genre/mood words are also passed straight through as tags.
const MOOD_TAGS = {
  chill:['chill','chillout','chillwave'], energetic:['energetic','upbeat'],
  focus:['instrumental','study','ambient'], melancholic:['melancholy','sad','melancholic'],
  party:['party','dance'], experimental:['experimental','avant-garde'],
  romantic:['romantic','love'], dark:['dark','dark ambient','industrial']
};
// Mood → Deezer playlist search terms. Playlists are the strongest KEYLESS mood
// signal — humans curated them for exactly this vibe.
const MOOD_PL_TERMS = {
  chill:['chill vibes','chillout'], energetic:['workout','high energy'],
  focus:['deep focus','study beats'], melancholic:['sad songs','melancholy'],
  party:['party hits','dance party'], experimental:['experimental','leftfield'],
  romantic:['love songs','romantic'], dark:['dark moody','dark electronic']
};
// Mood → discovery bias: >0 favours lesser-known artists, <0 allows mainstream.
const MOOD_DISCOVERY = { chill:0.4, focus:0.6, melancholic:0.6, experimental:1.0, party:-0.3, energetic:-0.1, romantic:0.0, dark:0.6 };

function normWord(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9& ]/g,'').replace(/\s+/g,' ').trim(); }
// Join key for matching the same artist across Deezer / iTunes / Last.fm.
function normName(s){
  return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/^the\s+/,'').replace(/&/g,'and').replace(/[^a-z0-9]+/g,'');
}
function matchGenre(token){
  const t = normWord(token); if (!t) return null;
  for (const [w,id] of GENRE_WORDS) if (t === w) return [id, DZ_GENRE[id]];
  for (const [w,id] of GENRE_WORDS){
    const re = new RegExp(`(^| )${w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}( |$)`);
    if (re.test(t)) return [id, DZ_GENRE[id]];
  }
  return null;
}

// ── Catalogue fetch helpers (each guarded; return null on any failure) ──────
// Deezer goes through the shared rate-limited dz() defined near httpRequest.
const LFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';   // Last.fm "no image" star
function lfm(method, params){
  if (!lastfmKey()) return Promise.resolve(null);
  const q = new URLSearchParams({ method, api_key: lastfmKey(), format: 'json', ...params }).toString();
  return httpRequest(`${LFM_BASE}/2.0/?${q}`)
    .catch(e => { console.warn('[Mood][LastFM]', method, e.message); return null; });
}
// iTunes Search is undocumented-but-real about rate limits (~20 calls/min per
// IP before it starts returning 403s). Mood Discovery fans out several of these
// per query, so they go through the same kind of serial pacing MusicBrainz uses
// rather than firing all at once.
let _itChain = Promise.resolve();
const itunes = pathAndQuery => {
  _itChain = _itChain.catch(() => {}).then(() => sleep(250));
  return _itChain
    .then(() => httpRequest(`${IT_BASE}${pathAndQuery}`))
    .catch(e => { console.warn('[Mood][iTunes]', e.message); return null; });
};
function itunesArt(url){ return url ? url.replace(/\/\d+x\d+bb\.(jpg|png)/, '/300x300bb.$1') : null; }
function dzArtist(a){ return { id:a.id, name:a.name,
  fans:(typeof a.nb_fan === 'number' ? a.nb_fan : null),
  image:a.picture_xl||a.picture_big||a.picture_medium||a.picture||null }; }
function discoveryFromFans(fans){
  if (fans == null) return 0.3;
  const v = 1 - (Math.log10(fans + 10) / 7);
  return Math.max(0, Math.min(1, v));
}
// Tally the artists inside a Deezer playlist's tracks → [{id,name,count}] by count.
function playlistArtistTally(tracks){
  const tally = new Map();
  for (const tr of tracks){
    const a = tr && tr.artist;
    if (!a || !a.name) continue;
    const key = normName(a.name); if (!key) continue;
    const rec = tally.get(key) || { id: a.id || null, name: a.name, count: 0 };
    rec.count++; if (!rec.id && a.id) rec.id = a.id;
    tally.set(key, rec);
  }
  return [...tally.values()].sort((x,y) => y.count - x.count);
}

// Cache.
const _moodCache    = new Map();
const MOOD_CACHE_TTL = 15 * 60 * 1000;
const MOOD_CACHE_MAX = 80;

app.post('/api/discover/mood', auth, apiLimiter, async (req, res) => {
  const seedsRaw = (req.body?.seeds || '').toString().trim().slice(0, 300);
  const moodRaw  = (req.body?.mood  || '').toString().trim().slice(0, 120);
  let   count = parseInt(req.body?.count) || 12;
  count = Math.max(4, Math.min(count, 20));
  if (!seedsRaw && !moodRaw)
    return res.status(400).json({ error: 'Add a few artists, genres, or pick a mood to get recommendations.' });

  // Mood Discovery is for finding music you do NOT have — an artist already in
  // Lidarr is noise here, and requesting it does nothing. Pull the library once
  // and use it to reject candidates at every stage below.
  const lib = (lidarrUrl() && lidarrKey())
    ? await getLibraryArtists().catch(() => null)
    : null;
  const owned = (lib && lib.valid) ? lib.names : null;      // null = filtering unavailable
  const isOwned = n => Boolean(owned && owned.has(normArtist(n)));

  // Last.fm availability is part of the key — linking a key in Admin →
  // Connections must not keep serving 15 minutes of keyless results. The
  // library size is in the key for the same reason: after adding an artist the
  // cached results still contain it, and it must drop out on the next search.
  const libStamp = owned ? `${_libGen}:${owned.size}` : 'nolib';
  const cacheKey = `v5|${count}|${lastfmKey() ? 'L' : '-'}|${libStamp}|${seedsRaw.toLowerCase()}|${moodRaw.toLowerCase()}`;
  const cached = _moodCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MOOD_CACHE_TTL)
    return res.json({ artists: cached.artists, cached: true, filteredLibrary: Boolean(owned) });

  // ── 1. Parse input ────────────────────────────────────────────────────────
  const tokens = seedsRaw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 6);
  const artistTokens = [], typedGenreWords = [], typedMoodWords = [], styleTerms = [];
  const explicitGenreIds = new Map();  // typed genres — these DO hard-filter
  const moods = new Set();
  let microGenreTyped = false;         // typed word is NARROWER than its Deezer family
  for (const tok of tokens){
    const g = matchGenre(tok), m = MOOD_WORDS[normWord(tok)];
    if (g){ explicitGenreIds.set(g[0], g[1]); typedGenreWords.push(normWord(tok));
            if (normWord(tok) !== normWord(g[1])) microGenreTyped = true; }
    else if (m){ moods.add(m); typedMoodWords.push(normWord(tok)); }
    else artistTokens.push(tok);
  }
  for (const m of moodRaw.split(/[,\n]+/).map(normWord).filter(Boolean))
    if (MOOD_WORDS[m]) moods.add(MOOD_WORDS[m]);

  // Mood-derived genres: for ANCHORING candidate discovery + weak evidence only.
  const moodGenreIds = new Map();
  for (const m of moods) for (const id of (MOOD_GENRES[m] || []))
    if (!explicitGenreIds.has(id) && !moodGenreIds.has(id)) moodGenreIds.set(id, DZ_GENRE[id]);
  const anchorGenreIds = new Map([...explicitGenreIds, ...moodGenreIds]);

  const hasGenreCtx = explicitGenreIds.size > 0 || moods.size > 0;
  let discoveryW = 2.2;
  for (const m of moods) discoveryW += (MOOD_DISCOVERY[m] || 0) * 1.6;
  discoveryW = Math.max(0.4, Math.min(discoveryW, 4.5));

  // Genre families accepted per DIMENSION (matched independently).
  const acceptExplicit = new Set();
  for (const id of explicitGenreIds.keys()) for (const fid of (GENRE_FAMILY[id] || [id])) acceptExplicit.add(fid);
  const acceptMood = new Set();
  for (const id of moodGenreIds.keys()) for (const fid of (GENRE_FAMILY[id] || [id])) acceptMood.add(fid);

  const reqGenreLabels = new Set([...[...explicitGenreIds.values()].map(l => l.toLowerCase()), ...typedGenreWords]);
  const itunesGenreMatches = g => {
    const x = String(g||'').toLowerCase(); if (!x) return false;
    for (const l of reqGenreLabels){ if (l && (x.includes(l) || l.includes(x.split('/')[0]))) return true; }
    return false;
  };

  // ── 2. Resolve seeds ──────────────────────────────────────────────────────
  // Old behaviour looked at Deezer's #1 hit only, and DROPPED the seed on any
  // name mismatch — so a slightly-off spelling or an alias contributed nothing
  // (fatal without Last.fm). Now: scan the top 5 for an exact / fuzzy name
  // match; failing that, accept Deezer's top *popular* hit (its relevance
  // ranking handles typos and aliases well). Tokens Deezer can't place at all
  // become free-text STYLE TERMS ("late-night ambient") that flow into tag and
  // playlist searches instead of silently vanishing.
  const nameMatches = (tok, name) => { const a = normName(tok), b = normName(name); return a.length>=3 && (a===b || a.includes(b) || b.includes(a)); };
  const seeds = (await Promise.all(artistTokens.map(async tok => {
    const r = await dz(`/search/artist?limit=5&q=${encodeURIComponent(tok)}`);
    const hits = r?.data || [];
    let hit = hits.find(h => normName(h.name) === normName(tok))
           || hits.find(h => nameMatches(tok, h.name)) || null;
    let confident = !!hit;
    if (!hit && hits[0] && (hits[0].nb_fan == null || hits[0].nb_fan >= 1500)) hit = hits[0];
    if (hit) return { name: hit.name, deezerId: hit.id, typed: tok, confident };
    return { name: tok, deezerId: null, typed: tok, confident: false };
  })));
  for (const s of seeds) if (!s.deezerId) styleTerms.push(normWord(s.typed));

  const seedKeySet = new Set();
  for (const s of seeds){ seedKeySet.add(normName(s.name)); }
  for (const t of tokens){ seedKeySet.add(normName(t)); }

  // Last.fm tags to query: mood tags + everything the user typed.
  const tagSet = new Set();
  for (const m of moods) for (const t of (MOOD_TAGS[m] || [])) tagSet.add(t);
  for (const w of [...typedGenreWords, ...typedMoodWords, ...styleTerms]) if (w) tagSet.add(w);
  const requestedTags = [...tagSet].slice(0, 6);
  const genreTagSet = new Set([...typedGenreWords, ...styleTerms]);
  const moodTagSet  = new Set(typedMoodWords);
  for (const m of moods) for (const t of (MOOD_TAGS[m] || [])) moodTagSet.add(t);

  // Deezer playlist search terms, each with the dimension it evidences.
  // 'style' terms are the user's literal words → they count for BOTH.
  const playlistTerms = [];
  for (const m of moods) for (const t of (MOOD_PL_TERMS[m] || [m]).slice(0, moods.size > 1 ? 1 : 2))
    playlistTerms.push({ term: t, kind: 'mood' });
  for (const w of typedGenreWords) playlistTerms.push({ term: w, kind: 'genre' });
  for (const w of styleTerms) if (w) playlistTerms.push({ term: w, kind: 'style' });
  const plQueries = playlistTerms.slice(0, 5);

  const itunesTerms = [...new Set([...typedGenreWords, ...styleTerms.filter(Boolean),
    ...[...explicitGenreIds.values()].map(l => l.toLowerCase())])].slice(0, 4);

  // ── 3. Candidate pool (joined across catalogues by normalised name) ────────
  const cand = new Map();
  const addC = (rawName, o = {}) => {
    const name = (rawName||'').toString().trim(); if (!name) return null;
    const key = normName(name); if (!key || seedKeySet.has(key)) return null;
    if (isOwned(name)) return null;          // already in Lidarr — not a discovery
    let c = cand.get(key);
    if (!c){ c = { key, name, image:null, fans:null, deezerId:null, order:cand.size,
      sources:new Set(), simSeeds:new Map(), simSources:new Set(), simPaths:0, deg:9,
      tagHits:new Set(), genreHint:new Set(), plTerms:new Set(), plKinds:new Set(), itunesGenre:null }; cand.set(key, c); }
    if (o.source) c.sources.add(o.source);
    if (o.deezerId && !c.deezerId) c.deezerId = o.deezerId;
    if (o.image && !c.image) c.image = o.image;
    if (o.fans != null && c.fans == null) c.fans = o.fans;
    if (o.seedName){
      c.simSeeds.set(o.seedName, Math.max(c.simSeeds.get(o.seedName)||0, o.closeness||0.5));
      c.simPaths++; if (o.source) c.simSources.add(o.source);
    }
    if (o.deg != null) c.deg = Math.min(c.deg, o.deg);
    if (o.tag) c.tagHits.add(o.tag);
    if (o.genreLabel) c.genreHint.add(o.genreLabel);
    if (o.plTerm){ c.plTerms.add(o.plTerm); if (o.plKind) c.plKinds.add(o.plKind); }
    if (o.itunesGenre && !c.itunesGenre) c.itunesGenre = o.itunesGenre;
    return c;
  };

  // 3a. Deezer similarity (first + second degree).
  const seedTop = new Map();
  await Promise.all(seeds.filter(s => s.deezerId).map(async s => {
    const r = await dz(`/artist/${s.deezerId}/related?limit=40`);
    const list = (r?.data || []).map(dzArtist);
    const closeness = s.confident ? 0.8 : 0.6;   // unconfident resolution → gentler weight
    for (const a of list) addC(a.name, { source:'deezer', seedName:s.name, closeness, deg:1, deezerId:a.id, fans:a.fans, image:a.image });
    seedTop.set(s.name, list.slice(0, 6));
  }));
  {
    let gcBudget = 10;   // second-degree related fetches (shared across seeds)
    const ls = [...seedTop.entries()].map(([n,l]) => ({ n, l, i:0 }));
    const jobs = [];
    while (gcBudget > 0 && ls.some(x => x.i < x.l.length))
      for (const x of ls){ if (gcBudget<=0) break; if (x.i < x.l.length){ jobs.push({ seedName:x.n, a:x.l[x.i++] }); gcBudget--; } }
    await Promise.all(jobs.map(async ({ seedName, a }) => {
      const r = await dz(`/artist/${a.id}/related?limit=20`);
      for (const g of (r?.data || []).map(dzArtist)) addC(g.name, { source:'deezer', seedName, closeness:0.4, deg:2, deezerId:g.id, fans:g.fans, image:g.image });
    }));
  }

  // 3b. Deezer playlist co-occurrence — the KEYLESS second similarity graph.
  // Fan-made "<artist>" playlists put the seed next to the artists curators
  // consider kin; artists appearing repeatedly are strong neighbours. This is
  // what keeps seed similarity rich when Last.fm isn't linked.
  await Promise.all(seeds.slice(0, 3).map(async s => {
    const r = await dz(`/search/playlist?limit=5&q=${encodeURIComponent(s.name)}`);
    const pls = (r?.data || []).filter(p => p && p.id && (p.nb_tracks||0) >= 20 && (p.nb_tracks||0) <= 500);
    const firstWord = normWord(s.name).split(' ')[0];
    const pick = pls.find(p => firstWord && normWord(p.title).includes(firstWord)) || pls[0];
    if (!pick) return;
    const t = await dz(`/playlist/${pick.id}/tracks?limit=80`);
    const tally = playlistArtistTally(t?.data || []);
    const manyArtists = tally.length >= 20;      // variety playlists list 1 track/artist
    for (const a of tally.slice(0, 15)){
      if (!manyArtists && a.count < 2) continue;
      addC(a.name, { source:'deezer-pl', seedName:s.name, closeness: Math.min(0.65, 0.3 + a.count*0.08), deg:2, deezerId:a.id });
    }
  }));

  // 3c. Last.fm similarity (third similarity graph; quality match scores).
  if (lastfmKey() && seeds.length){
    await Promise.all(seeds.map(async s => {
      const r = await lfm('artist.getsimilar', { artist: s.name, limit: 30, autocorrect: 1 });
      for (const x of (r?.similarartists?.artist || []))
        addC(x.name, { source:'lastfm', seedName:s.name, closeness: Math.max(0, Math.min(1, parseFloat(x.match)||0.5)), deg:1 });
    }));
  }

  // 3d. Last.fm tag → top artists (precise mood / micro-genre discovery).
  if (lastfmKey() && requestedTags.length){
    await Promise.all(requestedTags.map(async tag => {
      const r = await lfm('tag.gettopartists', { tag, limit: 40 });
      for (const x of (r?.topartists?.artist || [])) addC(x.name, { source:'lastfm', tag, deg:3 });
    }));
  }

  // 3e. Deezer mood/genre/style PLAYLISTS — curated fit evidence, keyless.
  if (plQueries.length){
    await Promise.all(plQueries.map(async ({ term, kind }) => {
      const r = await dz(`/search/playlist?limit=5&q=${encodeURIComponent(term)}`);
      // Niche terms ("dub techno", "night drive") often live in SMALL curated
      // playlists — requiring 25+ tracks throws away exactly the curation we
      // came for. Accept ≥8; among the top hits prefer a substantial one.
      const ok = (r?.data || []).filter(p => p && p.id && (p.nb_tracks||0) >= 8);
      const pick = ok.find(p => (p.nb_tracks||0) >= 25) || ok[0];
      if (!pick) return;
      const t = await dz(`/playlist/${pick.id}/tracks?limit=60`);
      for (const a of playlistArtistTally(t?.data || []).slice(0, 20))
        addC(a.name, { source:'deezer-pl', plTerm: term, plKind: kind, deg:3, deezerId:a.id });
    }));
  }

  // 3f. iTunes genre breadth (+ genre label + artwork). Keyless.
  if (itunesTerms.length){
    await Promise.all(itunesTerms.map(async term => {
      const r = await itunes(`/search?term=${encodeURIComponent(term)}&entity=album&media=music&limit=40`);
      for (const a of (r?.results || [])){
        if (!a.artistName) continue;
        addC(a.artistName, { source:'itunes', genreLabel: term, itunesGenre: a.primaryGenreName||null, image: itunesArt(a.artworkUrl100), deg:3 });
      }
    }));
  }

  // 3g. Deezer genre anchors → discover *within* the genre. Charts seed the
  // pool, but the related-graph expansion starts from DEEPER chart cuts —
  // related-of-the-top-3 is just more megastars, the opposite of discovery.
  if (anchorGenreIds.size){
    const genreList = [...anchorGenreIds.entries()].slice(0, 4);
    const anchorPicks = [];
    await Promise.all(genreList.map(async ([id, label]) => {
      const r = await dz(`/chart/${id}/artists?limit=50`);
      const list = (r?.data || []).map(dzArtist);
      for (const a of list) addC(a.name, { source:'deezer', genreLabel: label, deg:3, deezerId:a.id, fans:a.fans, image:a.image });
      for (const idx of [4, 14, 29]) if (list[idx]) anchorPicks.push({ label, a: list[idx] });
    }));
    await Promise.all(anchorPicks.slice(0, 6).map(async ({ label, a }) => {
      const r = await dz(`/artist/${a.id}/related?limit=20`);
      for (const g of (r?.data || []).map(dzArtist)) addC(g.name, { source:'deezer', genreLabel: label, deg:3, deezerId:g.id, fans:g.fans, image:g.image });
    }));
  }

  // 3h. Absolute fallback.
  let usedFallback = false;
  if (!cand.size){
    usedFallback = true;
    const r = await dz('/chart/0/artists?limit=25');
    for (const a of (r?.data || []).map(dzArtist)) addC(a.name, { source:'deezer', genreLabel:'Trending', deg:3, deezerId:a.id, fans:a.fans, image:a.image });
  }

  // ── 4. Pre-score (similarity + curated/tag evidence + discovery + agreement) ─
  const preScore = c => {
    const closeSum = [...c.simSeeds.values()].reduce((s,v) => s+v, 0);
    const sim = 6*Math.min(closeSum, 2.5)
              + (c.simSources.size >= 2 ? 3 : 0)        // two independent graphs agree
              + Math.min(c.simPaths, 4)*0.5
              + (c.deg===1 ? 1.5 : 0);
    const ghint = (c.tagHits.size ? 2.5 + Math.min(c.tagHits.size,3)*0.7 : 0)
                + (c.plTerms.size ? 2.4 + Math.min(c.plTerms.size,3)*0.8 : 0)
                + (c.plKinds.has('genre') || c.plKinds.has('style') ? 1.2 : 0)  // playlist named after the user's words
                + (c.itunesGenre ? 0.7 : 0)
                + (c.genreHint.size ? 1.0 : 0);
    const cross = (c.sources.size >= 2 ? 1.5 : 0) + (c.sources.size >= 3 ? 1.5 : 0);
    return sim + ghint + cross + discoveryW * discoveryFromFans(c.fans);
  };
  const pool = [...cand.values()].sort((a,b) => preScore(b) - preScore(a) || a.order - b.order);

  // ── 5. Verify finalists: ensure Deezer art/id, read real genre, rep album ─
  // Concurrency-limited: this used to fire 2 unthrottled Deezer calls per
  // finalist in one burst — a prime quota-tripper.
  const VERIFY_MAX = hasGenreCtx ? Math.min(count + 10, 26) : Math.min(count + 4, 18);
  const finalists = pool.slice(0, VERIFY_MAX);
  await mapLimit(finalists, 6, async c => {
    if (!c.deezerId){
      const r = await dz(`/search/artist?limit=3&q=${encodeURIComponent(c.name)}`);
      const hit = (r?.data || []).find(h => normName(h.name) === c.key || nameMatches(c.name, h.name));
      if (hit){
        c.deezerId = hit.id; c.name = hit.name;
        if (c.fans == null) c.fans = (typeof hit.nb_fan==='number'?hit.nb_fan:null);
        if (!c.image) c.image = hit.picture_xl||hit.picture_big||hit.picture_medium||null;
      }
    }
    if (c.deezerId){
      const r = await dz(`/artist/${c.deezerId}/albums?limit=25`);
      const albums = (r?.data || []).filter(x => x && x.id);
      const tally = {}; let best=null, bestN=0;
      for (const al of albums){ const g=al.genre_id; if (g&&g>0){ tally[g]=(tally[g]||0)+1; if (tally[g]>bestN){ bestN=tally[g]; best=g; } } }
      c.albumGenreId = best; c.albumGenreLabel = (best && DZ_GENRE[best]) || null;
      const lp = albums.find(a => a.record_type === 'album') || albums[0];
      c.album = lp ? lp.title : null;
    }

    // ── Fit: each requested dimension is matched INDEPENDENTLY ─────────────
    // Genre (typed): Deezer album-genre family | iTunes genre | Last.fm tag on
    //   a typed genre word | genre/style playlist membership.
    // Mood: mood tag | mood/style playlist membership | album genre in the
    //   mood's typical family (weak — real evidence, but moods aren't genres).
    const tagsArr = [...c.tagHits];
    // Literal evidence carries the user's OWN words (tag / playlist named after
    // them); family evidence is only membership in the broad Deezer family.
    // "dub techno" typed → a dub-techno playlist beats being #7 on the
    // Electronic chart, so with a micro-genre the family alone isn't a full fit.
    const literalG = tagsArr.some(t => genreTagSet.has(t))
        || c.plKinds.has('genre') || c.plKinds.has('style');
    const familyG = (c.albumGenreId != null && acceptExplicit.has(c.albumGenreId))
        || itunesGenreMatches(c.itunesGenre);
    const gOK = explicitGenreIds.size > 0 && (literalG || (familyG && !microGenreTyped));
    const mOK = moods.size > 0 && (
        tagsArr.some(t => moodTagSet.has(t))
        || c.plKinds.has('mood') || c.plKinds.has('style')
        || (c.albumGenreId != null && acceptMood.has(c.albumGenreId)));
    c.fit = (gOK ? 1 : 0) + (mOK ? 1 : 0);

    // Benefit of the doubt: an artist STRONGLY similar to a seed shouldn't sink
    // below chart names just because its genre couldn't be read (unknown ≠
    // mismatch), and strong seed-similarity is itself vibe evidence for a mood.
    const strongSim = c.simSources.size >= 2 || [...c.simSeeds.values()].some(v => v >= 0.6);
    let soft = 0;
    if (explicitGenreIds.size && !gOK && microGenreTyped && familyG) soft += 0.5;  // right family, wrong niche → filler band
    if (explicitGenreIds.size && !gOK && strongSim && c.albumGenreId == null) soft += 0.5;
    if (moods.size && !mOK && strongSim) soft += 0.5;
    c.fitSoft = soft;
  });

  // ── 5b. Second library pass ───────────────────────────────────────────────
  // Two things can only be checked now:
  //   • Verification rewrites c.name to Deezer's spelling, so a candidate that
  //     entered as "P!nk" may now read "Pink" and match the library.
  //   • Provider aliases ("STS9" vs Lidarr's "Sound Tribe Sector 9") match on
  //     neither spelling. Lidarr's own lookup IS alias-aware, so resolve the
  //     survivors to a foreignArtistId and check that against the library —
  //     the same deep check Search uses, and cheap here because it runs on at
  //     most VERIFY_MAX names and caches every resolution for the process.
  let kept = finalists.filter(c => !isOwned(c.name));
  if (owned && lib && kept.length) {
    const deep = await mapLimit(kept, 5, async c => {
      const fid = await lidarrFidForName(c.name);
      return (fid && lib.ids.has(fid)) ? c.key : null;
    });
    const ownedByAlias = new Set(deep.filter(Boolean));
    if (ownedByAlias.size) kept = kept.filter(c => !ownedByAlias.has(c.key));
  }

  // ── 6. Final score & selection ────────────────────────────────────────────
  // Full fits (every requested dimension satisfied) come first, then partial /
  // soft fits, then the rest — never a hard cut, so the grid always fills.
  const dims = (explicitGenreIds.size ? 1 : 0) + (moods.size ? 1 : 0);
  const finalScore = c => preScore(c) + (c.fit||0)*6 + (c.fitSoft||0)*3;
  let ranked = kept.slice().sort((a,b) => finalScore(b) - finalScore(a) || a.order - b.order);
  if (dims){
    const full    = ranked.filter(c => (c.fit||0) >= dims);
    const partial = ranked.filter(c => (c.fit||0) < dims && ((c.fit||0) + (c.fitSoft||0)) > 0);
    const rest    = ranked.filter(c => !(c.fit||0) && !(c.fitSoft||0));
    ranked = [...full, ...partial, ...rest];
  }
  ranked = ranked.slice(0, count);

  // ── 7. Shape response ──────────────────────────────────────────────────────
  const cap = s => s ? s.charAt(0).toUpperCase()+s.slice(1) : s;
  const artists = ranked.map(c => {
    const seedList = [...c.simSeeds.keys()].slice(0, 2);
    const tagLabel = [...c.tagHits][0] || null;
    const plLabel  = [...c.plTerms][0] || null;
    const gLabel   = c.albumGenreLabel || c.itunesGenre || [...c.genreHint][0] || (tagLabel ? cap(tagLabel) : null);
    const fitOK    = dims > 0 && (c.fit||0) > 0;
    let reason;
    if (seedList.length && fitOK && (gLabel||tagLabel)) reason = `${gLabel || cap(tagLabel)} · similar to ${seedList.join(' & ')}`;
    else if (seedList.length)                           reason = `Similar to ${seedList.join(' & ')}`;
    else if (plLabel && (moods.size || c.plKinds.has('style') || c.plKinds.has('genre'))) reason = `Curated in ${plLabel} playlists`;
    else if (fitOK && (gLabel||tagLabel))               reason = `${gLabel || cap(tagLabel)} discovery`;
    else if (gLabel)                                    reason = `Popular in ${gLabel}`;
    else                                                reason = 'Discovery pick';
    return {
      name:  c.name,
      image: c.image,
      album: c.album || null,
      reason,
      source: c.simSeeds.size ? 'Similar' : (c.plTerms.size ? 'Playlist' : (fitOK ? 'Discovery' : 'Trending'))
    };
  });

  if (!artists.length) {
    // Distinguish "the catalogues are down" from "everything we found, you
    // already own" — the second is a real (and reassuring) answer, not a fault.
    if (owned && cand.size === 0 && seeds.length)
      return res.json({ artists: [], filteredLibrary: true,
                        note: 'Everything similar to those seeds is already in your library — try different artists or a mood.' });
    return res.status(502).json({ error: 'Could not reach the music catalogues just now — try again in a moment.' });
  }

  _moodCache.set(cacheKey, { at: Date.now(), artists });
  if (_moodCache.size > MOOD_CACHE_MAX) _moodCache.delete(_moodCache.keys().next().value);

  console.log(`[Mood] ${req.user.username} → ${artists.length}/${cand.size} (artists=${seeds.length} genres=[${[...explicitGenreIds.values()].join(',')}] moods=[${[...moods].join(',')}] style=[${styleTerms.join(',')}] playlists=[${plQueries.map(p=>p.term).join(',')}] lastfm=${lastfmKey()?'on':'off'} tags=[${requestedTags.join(',')}] itunes=[${itunesTerms.join(',')}]${usedFallback?' [fallback]':''})`);
  res.json({ artists, filteredLibrary: Boolean(owned) });
});

// ── Artist image resolution (Deezer, cached) ───────────────────────────────
// MusicBrainz has no artist artwork, so search results used to render with the
// generated-avatar fallback. We resolve real pictures via Deezer's keyless
// search, cached in-memory so repeat searches (and the typeahead) don't re-hit
// Deezer for names we've already looked up. A miss/failed lookup caches null
// so the client just keeps its avatar fallback.
const _artistImgCache = new Map();          // name(lowercased) -> url | null
const ARTIST_IMG_CACHE_MAX = 1000;
async function deezerArtistImage(name) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  if (_artistImgCache.has(key)) return _artistImgCache.get(key);
  let img = null;
  try {
    const r   = await dz(`/search/artist?limit=1&q=${encodeURIComponent(name)}`);
    const hit = r?.data?.[0];
    img = hit?.picture_xl || hit?.picture_big || hit?.picture_medium || null;
  } catch { /* best-effort */ }
  // A null here means either "Deezer has no picture" or "Deezer was down".
  // Caching the second forever left tiles permanently on the avatar fallback,
  // so misses expire quickly while real hits are kept for the process lifetime.
  _artistImgCache.set(key, img);
  if (img === null) setTimeout(() => { if (_artistImgCache.get(key) === null) _artistImgCache.delete(key); }, 5 * 60 * 1000).unref?.();
  if (_artistImgCache.size > ARTIST_IMG_CACHE_MAX) _artistImgCache.delete(_artistImgCache.keys().next().value);
  return img;
}

// Same idea for album covers. Cover Art Archive 404s for a large share of
// MusicBrainz release-groups, so Deezer is the primary source and CAA the
// fallback (handled by the caller). Cached like artist images.
const _albumCoverCache = new Map();         // "artist|title"(lowercased) -> url | null
async function deezerAlbumCover(artist, title) {
  const key = `${artist || ''}|${title || ''}`.trim().toLowerCase();
  if (!title) return null;
  if (_albumCoverCache.has(key)) return _albumCoverCache.get(key);
  let img = null;
  try {
    const q   = `${artist || ''} ${title}`.trim();
    const r   = await dz(`/search/album?limit=1&q=${encodeURIComponent(q)}`);
    const hit = r?.data?.[0];
    img = hit?.cover_xl || hit?.cover_big || hit?.cover_medium || null;
  } catch { /* best-effort */ }
  _albumCoverCache.set(key, img);
  if (img === null) setTimeout(() => { if (_albumCoverCache.get(key) === null) _albumCoverCache.delete(key); }, 5 * 60 * 1000).unref?.();
  if (_albumCoverCache.size > ARTIST_IMG_CACHE_MAX) _albumCoverCache.delete(_albumCoverCache.keys().next().value);
  return img;
}

// ── Search ─────────────────────────────────────────────────────────────────
// Artists: Deezer is the PRIMARY source — every Deezer result carries real
// artwork natively, so pictures are guaranteed for anything Deezer knows.
// MusicBrainz runs in parallel purely for coverage (obscure acts Deezer
// lacks); its extras are appended after the Deezer hits and enriched
// best-effort. Either provider can fail without killing the search.
// Albums: MusicBrainz (needs release-groups) with Deezer covers, CAA fallback.
app.get('/api/search', auth, apiLimiter, async (req, res) => {
  const { q, type = 'artist' } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    if (type === 'album') {
      // .catch: MusicBrainz being down should degrade the album search to
      // "no results", not turn it into a 500.
      const data  = await mb(`/ws/2/release-group/?query=${encodeURIComponent(q)}&limit=20&fmt=json`)
        .catch(e => { console.warn('[MusicBrainz]', e.message); return null; });
      const items = data?.['release-groups'] || [];
      // Deezer covers first (reliable), Cover Art Archive as fallback —
      // CAA 404s for a large share of release-groups.
      const albums = await Promise.all(items.slice(0,18).map(async item => {
        const artist = item['artist-credit']?.[0]?.artist?.name || '';
        const cover  = await deezerAlbumCover(artist, item.title)
                    || `https://coverartarchive.org/release-group/${item.id}/front-250`;
        return { title:item.title, artist, cover, mbid:item.id, year:item['first-release-date']?.slice(0,4)||null, source:'MB' };
      }));
      return res.json(albums);
    }

    // ── Artists ────────────────────────────────────────────────────────────
    const [dzr, mbRes] = await Promise.all([
      dz(`/search/artist?limit=18&q=${encodeURIComponent(q)}`),
      mb(`/ws/2/artist/?query=${encodeURIComponent(q)}&limit=20&fmt=json`).catch(() => null)
    ]);
    if (!dzr && !mbRes) throw new Error('Search providers unavailable — try again in a moment');

    // MBIDs by name so Deezer hits can carry one when MusicBrainz agrees.
    // FIRST wins: MusicBrainz returns results by descending relevance, and the
    // Map constructor keeps the LAST value for a duplicate key — so building it
    // in one line used to attach the *lowest-scoring* same-name artist's MBID
    // (e.g. an obscure "Slipknot" instead of the real one).
    const mbArtists = mbRes?.artists || [];
    const mbByName  = new Map();
    for (const a of mbArtists) {
      const k = (a.name || '').trim().toLowerCase();
      if (k && !mbByName.has(k)) mbByName.set(k, a.id);
    }

    const seen = new Set();
    const out  = [];

    // Deezer hits first — guaranteed pictures.
    for (const a of (dzr?.data || [])) {
      const key = (a.name || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        name:  a.name,
        image: a.picture_xl || a.picture_big || a.picture_medium || null,
        mbid:  mbByName.get(key) || null,
        source:'Deezer'
      });
      // Cache the picture so the typeahead / future searches reuse it.
      if (!_artistImgCache.has(key)) _artistImgCache.set(key, a.picture_xl || a.picture_big || a.picture_medium || null);
    }

    // MusicBrainz-only extras for coverage, enriched best-effort (mostly the
    // obscure tail — a null image just falls back to the client avatar).
    const extras = mbArtists
      .filter(a => a.name && !seen.has(a.name.trim().toLowerCase()))
      .slice(0, Math.max(0, 18 - out.length));
    const enriched = await Promise.all(extras.map(async a =>
      ({ name:a.name, image:await deezerArtistImage(a.name), mbid:a.id, source:'MB' })
    ));
    out.push(...enriched);

    res.json(out.slice(0, 18));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Search autocomplete (typeahead) ────────────────────────────────────────
// Lightweight suggestions as the user types. Deezer only: keyless, fast, and
// returns artwork natively — MusicBrainz is throttled to ~1 req/sec, far too
// slow for keystroke-driven lookups. No MBID is returned, which is fine: the
// request modal resolves the exact Lidarr match by name anyway (same as the
// Deezer-sourced Discover tiles). Always answers 200 with items:[] on any
// upstream failure — a typeahead should never surface an error.
app.get('/api/search/suggest', auth, apiLimiter, async (req, res) => {
  const q    = (req.query.q || '').toString().trim();
  const type = req.query.type === 'album' ? 'album' : 'artist';
  if (q.length < 2) return res.json({ items: [] });
  try {
    if (type === 'album') {
      const r = await dz(`/search/album?limit=8&q=${encodeURIComponent(q)}`);
      return res.json({ items: (r?.data || []).map(a => ({
        type:  'album',
        title:  a.title,
        artist: a.artist?.name || '',
        cover:  a.cover_xl || a.cover_big || a.cover_medium || null,
        thumb:  a.cover_medium || a.cover_small || null,
        year:   a.release_date ? String(a.release_date).slice(0,4) : null
      })) });
    }
    const r = await dz(`/search/artist?limit=8&q=${encodeURIComponent(q)}`);
    res.json({ items: (r?.data || []).map(a => ({
      type:  'artist',
      name:   a.name,
      image:  a.picture_xl || a.picture_big || a.picture_medium || null,
      thumb:  a.picture_medium || a.picture_small || null
    })) });
  } catch { res.json({ items: [] }); }
});

// ── Requests ───────────────────────────────────────────────────────────────
// GET supports optional filtering via query params so dashboards / API
// consumers can search and filter without pulling the whole list:
//   ?search=<text>   match against artist, album, username, or type
//   ?status=<s>      filter by lidarrStatus/status (sent, exists, error, …)
//   ?type=<t>        filter by request type (artist | album)
//   ?limit=<n>       cap the number of results returned (most recent first)
// Admins (and API keys, which act as admins) see all requests; regular users
// only see their own.
function filterRequests(list, query) {
  const search = (query.search || '').toString().trim().toLowerCase();
  const status = (query.status || '').toString().trim().toLowerCase();
  const type   = (query.type   || '').toString().trim().toLowerCase();
  const limit  = parseInt(query.limit) || 0;

  let out = list;
  if (search) {
    out = out.filter(r =>
      [r.artistName, r.albumName, r.username, r.type]
        .some(v => (v || '').toString().toLowerCase().includes(search))
    );
  }
  if (status) {
    // Approval states filter on the normalised approval field (this is what
    // makes ?status=approved work, and keeps pending/rejected correct even for
    // a pending row that carries a Lidarr failure message from a retried
    // approval). Everything else filters on the raw Lidarr status as before.
    if (status === 'approved' || status === 'pending' || status === 'rejected') {
      out = out.filter(r => approvalOf(r) === status);
    } else {
      out = out.filter(r => ((r.lidarrStatus || r.status || '').toLowerCase() === status));
    }
  }
  if (type)   out = out.filter(r => ((r.type || 'artist').toLowerCase() === type));

  out = out.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (limit > 0) out = out.slice(0, limit);
  return out;
}

// Every request leaves the API with a normalised approvalStatus, so consumers
// (the app, dashboards, scripts) never have to special-case legacy pre-2.6 rows.
function withApproval(list) {
  return list.map(r => ({ ...r, approvalStatus: approvalOf(r) }));
}

app.get('/api/requests', auth, apiLimiter, (req, res) => {
  maybeSweep();                                     // throttled, non-blocking
  const db   = readDB();
  const me   = resolveUser(db, req.user);
  const base = req.user.role === 'admin' ? db.requests : db.requests.filter(r => requestBelongsTo(r, me));
  res.json(withApproval(filterRequests(base, req.query)));
});

// Request tallies for the Admin page and dashboards — total / approved /
// pending / rejected (+ ok / problem / today). Cheap: no Lidarr round-trip,
// unlike /api/summary. Same numbers as /api/summary → requests, guaranteed,
// because both use requestCounts().
app.get('/api/requests/stats', auth, adminOnly, apiLimiter, (req, res) => {
  maybeSweep();
  res.json(requestCounts(readDB()));
});

app.get('/api/requests/mine', auth, apiLimiter, (req, res) => {
  maybeSweep();
  const db = readDB();
  const me = resolveUser(db, req.user);
  const list = db.requests.filter(r => requestBelongsTo(r, me));
  // Same search/status/type/limit filtering as /api/requests so API consumers
  // get consistent behaviour on their own requests too.
  res.json(withApproval(filterRequests(list, req.query)));
});

// Resolve a user's effective daily limit. `parseInt(x) || 10` silently rewrote
// a deliberate limit of 0 to 10 (so "let this user browse but never request"
// was unsettable even though the form offers min="0"), and let a negative value
// through, where `requestsToday >= -1` blocked the account with the nonsense
// message "Daily limit reached (-1/day)".
function dailyLimitOf(user) {
  const n = parseInt(user?.requestLimit, 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

app.post('/api/requests', auth, apiLimiter, async (req, res) => {
  const {
    type, artistName, albumName, cover, qualityProfileId, qualityName,
    year, mbid, foreignArtistId, foreignAlbumId
  } = req.body || {};

  if (!artistName || typeof artistName !== 'string' || !artistName.trim())
    return res.status(400).json({ error: 'artistName is required.' });

  // Only ever store a known type — never free-form client input (which would
  // otherwise land unescaped in the admin requests view).
  const reqType = (type === 'album' || (!type && albumName)) ? 'album' : 'artist';
  const cleanArtist = String(artistName).trim().slice(0, 200);
  const cleanAlbum  = albumName ? String(albumName).trim().slice(0, 200) : null;

  // ── Validation + RESERVATION pass ────────────────────────────────────────
  // The limit used to be checked here and incremented only after the Lidarr
  // round-trip — a multi-second window during which every concurrent request
  // saw the same pre-increment count and passed. Reserving the slot up front
  // (and releasing it if we bail) makes check-and-consume atomic within this
  // single-threaded process.
  let autoApproved = true;
  let reserved     = false;
  const releaseSlot = () => {
    if (!reserved) return;
    reserved = false;
    try {
      const d = readDB();
      const u = resolveUser(d, req.user);
      if (u && u.requestsToday > 0) { u.requestsToday -= 1; writeDB(d); }
    } catch (e) { console.warn('[Request] could not release reserved slot:', e.message); }
  };

  if (!req.user.viaApiKey) {
    const pre  = readDB();
    const user = resolveUser(pre, req.user);
    if (!user)            return res.status(403).json({ error: 'User not found — please log out and log back in.' });
    if (!user.canRequest) return res.status(403).json({ error: 'Requests disabled for your account.' });
    syncDailyCount(user);
    const dailyLimit = dailyLimitOf(user);
    if (user.requestsToday >= dailyLimit) {
      return res.status(429).json({
        error: dailyLimit === 0
          ? 'Requesting is disabled for your account.'
          : `Daily limit reached (${dailyLimit}/day) — your requests reset at midnight.`
      });
    }
    autoApproved = isAutoApproved(pre, req.user, user);
    user.requestsToday += 1;                       // reserve BEFORE the slow call
    if (!saveDB(pre, res, 'reserve request slot')) return;
    reserved = true;
  }

  // Pending requests are parked in the DB and sent to Lidarr only when an
  // admin approves them (POST /api/requests/:id/approve).
  let lidarr = null;
  if (autoApproved) {
    try {
      lidarr = await sendToLidarr(
        reqType, cleanArtist, cleanAlbum,
        qualityProfileId || null, foreignArtistId || null, foreignAlbumId || null
      );
    } catch (e) {                                   // sendToLidarr shouldn't throw, but never strand a reservation
      lidarr = { ok: false, status: 'error', message: e.message };
    }
  }

  // ── Commit pass — read db.json FRESH after the (slow) Lidarr round-trip ──
  // The old code held a db snapshot across the await above; anything written
  // in the meantime (another browser's preferences, an admin edit, an API-key
  // lastUsed) got silently clobbered when the stale snapshot was written back.
  // That's what made the admin's "notification seen" marker rewind and replay
  // old requests as new. Reading fresh here closes that window.
  let db;
  try { db = readDB(); }
  catch (e) { releaseSlot(); console.error('[AudioSeerr]', e.message); return res.status(503).json({ error: 'Data store unavailable.' }); }

  let user;
  if (req.user.viaApiKey) {
    user = { id: req.user.id, username: req.user.username };
  } else {
    user = resolveUser(db, req.user);
    if (!user) { releaseSlot(); return res.status(403).json({ error: 'User not found — please log out and log back in.' }); }
  }

  // A failed auto-approve is stored as PENDING, exactly like a failed approval.
  // Storing it as approved+error made it a dead end: the approve route 409s on
  // anything not pending/rejected and the reject route 409s on anything not
  // pending, so the row could be neither retried nor cleared — only deleted.
  const delivered = Boolean(autoApproved && lidarr && lidarr.ok);
  const request = {
    // Date.now() alone collides for two requests in the same millisecond, and
    // every consumer resolves by first match — so approve/reject/delete could
    // act on the wrong row and leave the real one permanently stuck.
    id:               newId('req'),
    userId:           user.id,
    username:         user.username,
    type:             reqType,
    artistName:       cleanArtist,
    albumName:        reqType === 'album' ? cleanAlbum : null,
    cover:            safeImageUrl(cover),
    mbid:             mbid||null,
    foreignArtistId:  foreignArtistId||null,
    foreignAlbumId:   foreignAlbumId||null,
    qualityProfileId: qualityProfileId||null,
    quality:          qualityName||'Default',
    year:             year||null,
    status:           delivered ? 'sent' : 'pending',
    lidarrStatus:     delivered ? lidarr.status : null,
    lidarrType:       delivered ? (lidarr.lidarrType || null) : null,
    lidarrMessage:    delivered ? lidarr.message
                       : (autoApproved ? `Auto-approval failed: ${lidarr?.message || 'Lidarr unreachable'} — approve again to retry.`
                                       : 'Waiting for admin approval'),
    lidarrId:         delivered ? (lidarr.lidarrId ?? null) : null,
    approvalStatus:   delivered ? 'approved' : 'pending',
    decidedBy:        delivered ? 'auto' : null,
    decidedAt:        delivered ? new Date().toISOString() : null,
    availableAt:      null,
    createdAt:        new Date().toISOString(),
    updatedAt:        new Date().toISOString()
  };
  db.requests.push(request);
  if (!saveDB(db, res, 'create request')) { releaseSlot(); return; }
  reserved = false;                                  // committed — the slot is now genuinely spent
  console.log(`[Request] ${user.username} → ${reqType}: "${cleanAlbum||cleanArtist}" | ${delivered ? `Lidarr: ${lidarr.status}` : (autoApproved ? 'AUTO-APPROVE FAILED → pending' : 'PENDING approval')}`);
  notify(delivered ? 'request.created' : (autoApproved ? 'request.failed' : 'request.pending'), request);
  res.status(201).json(request);
});

// ── Approve / reject (admin) ────────────────────────────────────────────────
// Overseerr-style moderation. Approving a pending (or previously rejected)
// request performs the Lidarr send that was skipped at creation time. If the
// Lidarr send FAILS, the request deliberately stays PENDING (with the error
// recorded in lidarrMessage) so the admin can fix the connection and hit
// Approve again — approval only "commits" once Lidarr accepted the artist.
// Uses adminOnly (not sessionAdminOnly) so dashboards driving the API with an
// AudioSeerr key can moderate requests too.
function requestIsPending(r)  { return approvalOf(r) === 'pending'; }
function requestIsRejected(r) { return approvalOf(r) === 'rejected'; }

app.post('/api/requests/:id/approve', auth, adminOnly, apiLimiter, async (req, res) => {
  // ── Validation pass (read-only) ──────────────────────────────────────────
  const pre = readDB();
  const r0  = pre.requests.find(r => r.id === req.params.id);
  if (!r0) return res.sendStatus(404);
  if (!requestIsPending(r0) && !requestIsRejected(r0)) {
    return res.status(409).json({ error: 'This request has already been approved.' });
  }

  // Remember what the row looked like BEFORE the attempt. Re-approving a
  // rejected request is a supported action (the UI deliberately keeps an
  // Approve button on rejected rows), and when it failed the old code
  // unconditionally rewrote the row to "pending" — silently destroying the
  // rejection reason, the reviewer and the decision timestamp for an operation
  // that did not even succeed.
  const prev = {
    approval: approvalOf(r0),
    status:   r0.status,
    message:  r0.lidarrMessage,
    by:       r0.decidedBy,
    at:       r0.decidedAt
  };

  const lidarr = await sendToLidarr(
    r0.type, r0.artistName, r0.albumName || null,
    r0.qualityProfileId || null, r0.foreignArtistId || null, r0.foreignAlbumId || null
  );

  // ── Commit pass — read db.json FRESH after the (slow) Lidarr round-trip ──
  // (same stale-snapshot rule as POST /api/requests).
  const db = readDB();
  const r  = db.requests.find(x => x.id === req.params.id);
  if (!r) return res.sendStatus(404);                    // deleted meanwhile
  const now = new Date().toISOString();
  if (lidarr.ok) {
    r.status          = 'sent';                           // sent | (lidarrStatus may be 'exists')
    r.lidarrStatus    = lidarr.status;
    r.lidarrType      = lidarr.lidarrType || null;
    r.lidarrMessage   = lidarr.message;
    r.lidarrId        = lidarr.lidarrId ?? null;
    r.approvalStatus  = 'approved';
    r.decidedBy       = req.user.username;
    r.decidedAt       = now;
    r.lastApprovalError = null;
  } else {
    // A failed attempt must not move the row. Restore exactly what was there
    // and record the error alongside it, so a pending row stays retriable and a
    // rejected row stays rejected (with its reason intact).
    r.approvalStatus    = prev.approval;
    r.status            = prev.approval === 'rejected' ? 'rejected' : 'pending';
    r.lidarrStatus      = null;
    r.lidarrMessage     = prev.message;
    r.decidedBy         = prev.by;
    r.decidedAt         = prev.at;
    r.lastApprovalError = `Approval failed: ${lidarr.message}`;
  }
  r.updatedAt = now;
  if (!saveDB(db, res, 'approve request')) return;
  console.log(`[Approval] ${req.user.username} approved "${r.albumName||r.artistName}" → Lidarr: ${lidarr.status}`);
  if (lidarr.ok) notify('request.approved', r);
  res.json(r);
});

app.post('/api/requests/:id/reject', auth, adminOnly, apiLimiter, (req, res) => {
  const db = readDB();
  const r  = db.requests.find(x => x.id === req.params.id);
  if (!r) return res.sendStatus(404);
  if (!requestIsPending(r)) {
    return res.status(409).json({ error: 'Only pending requests can be rejected.' });
  }
  const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
  const now    = new Date().toISOString();
  r.status         = 'rejected';
  r.lidarrStatus   = null;
  r.lidarrMessage  = reason ? `Rejected: ${reason}` : `Rejected by ${req.user.username}`;
  r.approvalStatus = 'rejected';
  r.decidedBy      = req.user.username;
  r.decidedAt      = now;
  r.updatedAt      = now;
  r.rejectReason   = reason || null;          // kept separately so the UI can show it verbatim
  if (!saveDB(db, res, 'reject request')) return;
  console.log(`[Approval] ${req.user.username} rejected "${r.albumName||r.artistName}"${reason ? ` (${reason})` : ''}`);
  notify('request.rejected', r);
  res.json(r);
});

app.delete('/api/requests/:id', auth, apiLimiter, (req, res) => {
  const db  = readDB();
  const idx = db.requests.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.sendStatus(404);
  if (req.user.role !== 'admin') {
    const me = resolveUser(db, req.user);
    if (!requestBelongsTo(db.requests[idx], me)) return res.sendStatus(403);
  }
  db.requests.splice(idx, 1);
  if (!saveDB(db, res, 'delete request')) return;
  res.sendStatus(204);
});

// ── Users ──────────────────────────────────────────────────────────────────
// sessionAdminOnly, matching every other /api/users route: the user list carries
// usernames, roles and quota state, and an external service key has no business
// enumerating accounts.
app.get('/api/users', auth, sessionAdminOnly, apiLimiter, (req, res) => {
  const db = readDB();
  let changed = false;
  db.users.forEach(u => { if (syncDailyCount(u)) changed = true; });
  if (changed) { try { writeDB(db); } catch (e) { console.warn('[AudioSeerr] daily-count sync not persisted:', e.message); } }
  res.json(db.users.map(({ passwordHash, ...u }) => u));
});

// Shared validation so the create and update paths cannot drift.
const MIN_PASSWORD_LEN = 4;
function normaliseUsername(raw) {
  const s = String(raw || '').trim();
  if (s.length < 1 || s.length > 60) return null;
  if (!/^[\w.@ -]+$/.test(s)) return null;      // keep it renderable and file-safe
  return s;
}

app.post('/api/users', auth, sessionAdminOnly, apiLimiter, async (req, res) => {
  const { username, password, role='user', requestLimit=10, canRequest=true, autoApprove=false } = req.body||{};
  const uname = normaliseUsername(username);
  if (!uname)     return res.status(400).json({ error: 'Username must be 1-60 characters (letters, numbers, . _ - @ or space).' });
  if (!password || String(password).length < MIN_PASSWORD_LEN)
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
  // Hash BEFORE reading the db for the write — holding a snapshot across the
  // await would clobber anything saved in the meantime.
  const passwordHash0 = await bcrypt.hash(String(password), 10);
  const db = readDB();
  if (db.users.find(u => u.username === uname)) return res.status(409).json({ error: 'Username already exists.' });
  const user = {
    // Millisecond ids collide under concurrent creation, and every id lookup
    // takes the first match — leaving the second record unmanageable.
    id: newId('usr'), username: uname,
    passwordHash: passwordHash0,
    role: role === 'admin' ? 'admin' : 'user',
    requestLimit: dailyLimitOf({ requestLimit }), canRequest: Boolean(canRequest),
    autoApprove: Boolean(autoApprove),
    tokenVersion: 0,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  if (!saveDB(db, res, 'create user')) return;
  const { passwordHash, ...safe } = user;
  res.status(201).json(safe);
});

app.patch('/api/users/:id', auth, sessionAdminOnly, apiLimiter, async (req, res) => {
  const { password, passwordHash, id, createdAt, role, username, ...fields } = req.body||{};
  if (password !== undefined && String(password).length < MIN_PASSWORD_LEN)
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
  // Hash BEFORE reading the db for the write (see POST /api/users).
  const newHash = password ? await bcrypt.hash(String(password), 10) : null;
  const db  = readDB();
  const idx = db.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.sendStatus(404);
  const target = db.users[idx];

  // Whitelisted, validated updates only — no mass-assignment of internal fields.
  if (username !== undefined && username !== target.username) {
    const uname = normaliseUsername(username);
    if (!uname) return res.status(400).json({ error: 'Username must be 1-60 characters (letters, numbers, . _ - @ or space).' });
    if (db.users.find(u => u.username === uname)) return res.status(409).json({ error: 'Username already exists.' });
    target.username = uname;
    // Keep the denormalised copy on request rows honest, so the admin table and
    // "requested by" lines don't show a name that no longer exists.
    db.requests.forEach(r => { if (r.userId === target.id) r.username = uname; });
  }

  // Any privilege or credential change REVOKES existing sessions for that user.
  // Without this, demoting an admin changed nothing until their (up to 365-day)
  // token expired — the old token still asserted role:'admin'.
  let revoke = false;
  if (role !== undefined) {
    const next = role === 'admin' ? 'admin' : 'user';
    if (next !== target.role) revoke = true;
    // Don't let the last admin be demoted into a lockout.
    if (next === 'user' && target.role === 'admin' && db.users.filter(u => u.role === 'admin').length <= 1)
      return res.status(400).json({ error: 'Cannot demote the last remaining admin.' });
    target.role = next;
  }
  if (fields.requestLimit !== undefined) target.requestLimit = dailyLimitOf({ requestLimit: fields.requestLimit });
  if (fields.canRequest   !== undefined) target.canRequest   = Boolean(fields.canRequest);
  if (fields.autoApprove  !== undefined) target.autoApprove  = Boolean(fields.autoApprove);
  if (newHash) { target.passwordHash = newHash; target.passwordChangedAt = new Date().toISOString(); revoke = true; }
  if (revoke)  target.tokenVersion = (target.tokenVersion || 0) + 1;

  if (!saveDB(db, res, 'update user')) return;
  if (revoke) console.log(`[AudioSeerr] Sessions revoked for "${target.username}" (role/password change by "${req.user.username}").`);
  const { passwordHash: ph, ...safe } = target;
  res.json(safe);
});

app.delete('/api/users/:id', auth, sessionAdminOnly, apiLimiter, (req, res) => {
  const db  = readDB();
  const idx = db.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.sendStatus(404);
  if (db.users[idx].role === 'admin') return res.status(400).json({ error: 'Cannot delete admin.' });
  const gone = db.users[idx];
  db.users.splice(idx, 1);
  // Clean up what the account leaves behind. Orphaned rows used to be
  // reclaimable by a later namesake, and orphaned preferences just accumulated.
  const keep = db.requests.filter(r => r.userId !== gone.id);
  const orphaned = db.requests.length - keep.length;
  db.requests = keep;
  delete db.preferences[gone.id];
  if (!saveDB(db, res, 'delete user')) return;
  console.log(`[AudioSeerr] User "${gone.username}" deleted (${orphaned} request(s) removed).`);
  res.sendStatus(204);
});

// ── API keys ─────────────────────────────────────────────────────────────
// Lets external programs (scripts, automations, other dashboards) talk to the
// AudioSeerr API. Send the key as `X-Api-Key: <key>` (or Authorization: Bearer).
// Managed only from a logged-in admin session (see sessionAdminOnly).
function genApiKey() { return 'as_' + crypto.randomBytes(24).toString('hex'); }

app.get('/api/apikeys', auth, sessionAdminOnly, (req, res) => {
  const db = readDB();
  res.json(db.apiKeys.map(k => ({
    id: k.id, label: k.label, key: k.key,
    createdAt: k.createdAt, lastUsed: k.lastUsed || null
  })));
});

app.post('/api/apikeys', auth, sessionAdminOnly, (req, res) => {
  const { label } = req.body || {};
  const db  = readDB();
  const rec = {
    id:        newId('key'),
    label:     (label || '').toString().trim().slice(0, 60) || 'API Key',
    key:       genApiKey(),
    createdAt: new Date().toISOString(),
    lastUsed:  null
  };
  db.apiKeys.push(rec);
  if (!saveDB(db, res, 'create API key')) return;
  console.log(`[AudioSeerr] API key generated: "${rec.label}"`);
  res.status(201).json(rec);
});

// Regenerate the key value for an existing entry (keeps its label/id).
app.post('/api/apikeys/:id/regenerate', auth, sessionAdminOnly, (req, res) => {
  const db  = readDB();
  const rec = db.apiKeys.find(k => k.id === req.params.id);
  if (!rec) return res.sendStatus(404);
  rec.key      = genApiKey();
  rec.lastUsed = null;
  if (!saveDB(db, res, 'regenerate API key')) return;
  res.json(rec);
});

app.delete('/api/apikeys/:id', auth, sessionAdminOnly, (req, res) => {
  const db  = readDB();
  const idx = db.apiKeys.findIndex(k => k.id === req.params.id);
  if (idx === -1) return res.sendStatus(404);
  db.apiKeys.splice(idx, 1);
  if (!saveDB(db, res, 'revoke API key')) return;
  res.sendStatus(204);
});

// ── User preferences (server-side, synced across browsers/devices) ─────────
// Anything a user toggles in the UI (e.g. Discover source per section, the
// admin new-request "seen" marker) lives here instead of localStorage, so it
// persists permanently in db.json and follows the user to every browser. Keyed
// by the user's id. API-key service accounts have no personal UI, so they read
// defaults and their writes are ignored.
const DEFAULT_PREFS = {
  discoverSources: { artists: 'deezer', albums: 'deezer', upcoming: 'itunes' },
  notifSeenAt: null
};

function getPrefs(db, userId) {
  const stored = db.preferences[userId] || {};
  return {
    ...DEFAULT_PREFS,
    ...stored,
    discoverSources: { ...DEFAULT_PREFS.discoverSources, ...(stored.discoverSources || {}) }
  };
}

// Preferences are keyed by the user's CURRENT db id. JWTs live 365 days, so
// resolve the token to the db user (id, falling back to username) the same way
// every other route does — a token minted before a db.json reset must still map
// to the same preference record.
function prefKeyFor(db, tokenUser) {
  const u = resolveUser(db, tokenUser);
  return u ? u.id : tokenUser.id;
}

app.get('/api/preferences', auth, apiLimiter, (req, res) => {
  if (req.user.viaApiKey) return res.json(DEFAULT_PREFS);
  const db = readDB();
  res.json(getPrefs(db, prefKeyFor(db, req.user)));
});

// Merge-update the current user's preferences. Only known keys are accepted so a
// client can't bloat db.json with arbitrary data.
app.put('/api/preferences', auth, apiLimiter, (req, res) => {
  if (req.user.viaApiKey) return res.json(DEFAULT_PREFS); // nothing to persist
  const db   = readDB();
  const key  = prefKeyFor(db, req.user);
  const cur  = getPrefs(db, key);
  const body = req.body || {};

  if (body.discoverSources && typeof body.discoverSources === 'object') {
    for (const section of ['artists', 'albums', 'upcoming']) {
      const v = body.discoverSources[section];
      if (['deezer', 'itunes', 'lastfm'].includes(v)) cur.discoverSources[section] = v;
    }
  }
  // notifSeenAt is a MONOTONIC high-water mark: it only ever advances. A
  // browser that loaded the page with a stale copy can therefore never rewind
  // the "seen" marker for every other device (which is what caused already-
  // checked requests to pop up as new again).
  if (body.notifSeenAt !== undefined && body.notifSeenAt !== null) {
    const t = new Date(body.notifSeenAt);
    if (!isNaN(t)) {
      const curMs = cur.notifSeenAt ? new Date(cur.notifSeenAt).getTime() : 0;
      if (t.getTime() > curMs) cur.notifSeenAt = t.toISOString();
    }
  }

  db.preferences[key] = cur;
  if (!saveDB(db, res, 'save preferences')) return;
  res.json(cur);
});

// ── Approval settings (Admin → Request Approvals) ──────────────────────────
// Reads are open to any admin credential (dashboards included); the write is
// locked to a logged-in admin session, matching the other global settings.
app.get('/api/settings/approvals', auth, adminOnly, apiLimiter, (req, res) => {
  res.json(approvalCfg(readDB()));
});

app.put('/api/settings/approvals', auth, sessionAdminOnly, apiLimiter, (req, res) => {
  const body = req.body || {};
  const db   = readDB();
  if (!db.settings.approvals || typeof db.settings.approvals !== 'object') db.settings.approvals = {};
  if (body.autoApproveAll !== undefined) {
    db.settings.approvals.autoApproveAll = Boolean(body.autoApproveAll);
  }
  db.settings.approvals.updatedAt = new Date().toISOString();
  if (!saveDB(db, res, 'save approval settings')) return;
  const cfg = approvalCfg(db);
  console.log(`[AudioSeerr] Auto-approve all requests → ${cfg.autoApproveAll ? 'ON' : 'OFF'} (by "${req.user.username}")`);
  res.json(cfg);
});

// ── Lidarr add behaviour (Admin → Connections) ─────────────────────────────
// Controls how much work each add creates for Lidarr (see lidarrAddCfg).
app.get('/api/settings/lidarr-add', auth, adminOnly, apiLimiter, (req, res) => {
  res.json(lidarrAddCfg(readDB()));
});

app.put('/api/settings/lidarr-add', auth, sessionAdminOnly, apiLimiter, async (req, res) => {
  const body = req.body || {};
  const db   = readDB();
  if (!db.settings.lidarrAdd || typeof db.settings.lidarrAdd !== 'object') db.settings.lidarrAdd = {};
  if (body.monitor !== undefined) {
    if (!LIDARR_MONITOR_MODES.has(body.monitor)) {
      return res.status(400).json({ error: `monitor must be one of: ${[...LIDARR_MONITOR_MODES].join(', ')}` });
    }
    db.settings.lidarrAdd.monitor = body.monitor;
  }
  if (body.searchOnAdd !== undefined) db.settings.lidarrAdd.searchOnAdd = Boolean(body.searchOnAdd);
  // Root folder / metadata profile: validated against what Lidarr actually
  // reports, and '' clears the override back to "whatever Lidarr lists first".
  if (body.rootFolderPath !== undefined) {
    const want = String(body.rootFolderPath || '').trim();
    if (!want) delete db.settings.lidarrAdd.rootFolderPath;
    else {
      let cfg; try { cfg = await getLidarrConfig(); } catch { cfg = null; }
      if (cfg && !cfg.rootFolders.some(r => r.path === want))
        return res.status(400).json({ error: 'That root folder is not configured in Lidarr.' });
      db.settings.lidarrAdd.rootFolderPath = want;
    }
  }
  if (body.metadataProfileId !== undefined) {
    const want = parseInt(body.metadataProfileId, 10);
    if (!Number.isFinite(want)) delete db.settings.lidarrAdd.metadataProfileId;
    else {
      let cfg; try { cfg = await getLidarrConfig(); } catch { cfg = null; }
      if (cfg && !cfg.metadataProfiles.some(m => m.id === want))
        return res.status(400).json({ error: 'That metadata profile does not exist in Lidarr.' });
      db.settings.lidarrAdd.metadataProfileId = want;
    }
  }
  db.settings.lidarrAdd.updatedAt = new Date().toISOString();
  if (!saveDB(db, res, 'save Lidarr add settings')) return;
  const cfg = lidarrAddCfg(db);
  console.log(`[AudioSeerr] Lidarr add behaviour → monitor="${cfg.monitor}" searchOnAdd=${cfg.searchOnAdd} (by "${req.user.username}")`);
  res.json(cfg);
});

// ── Retention settings (Admin → Request Approvals card) ────────────────────
app.get('/api/settings/retention', auth, adminOnly, apiLimiter, (req, res) => {
  res.json(retentionCfg(readDB()));
});
app.put('/api/settings/retention', auth, sessionAdminOnly, apiLimiter, (req, res) => {
  const b  = req.body || {};
  const db = readDB();
  if (!db.settings.retention || typeof db.settings.retention !== 'object') db.settings.retention = {};
  if (b.keepDays !== undefined) {
    const n = parseInt(b.keepDays, 10);
    db.settings.retention.keepDays = Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : 0;
  }
  if (b.keepMax !== undefined) {
    const n = parseInt(b.keepMax, 10);
    db.settings.retention.keepMax = Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0;
  }
  db.settings.retention.updatedAt = new Date().toISOString();
  if (!saveDB(db, res, 'save retention settings')) return;
  const cfg = retentionCfg(db);
  console.log(`[AudioSeerr] Retention → keepDays=${cfg.keepDays || 'off'} keepMax=${cfg.keepMax || 'off'} (by "${req.user.username}")`);
  res.json(cfg);
});

// ── Notification targets (Admin → Notifications) ───────────────────────────
// Same shape as the other settings pairs: readable by any admin credential,
// writable only from a logged-in admin session. URLs can carry embedded tokens
// (ntfy/Gotify/Discord all do), so they are treated like the Lidarr key — never
// exposed to an API-key caller and masked on the way out.
function maskUrl(u) {
  try {
    const x = new URL(u);
    const tail = x.pathname.length > 8 ? '…' + x.pathname.slice(-6) : x.pathname;
    return `${x.protocol}//${x.host}${tail}`;
  } catch { return '(invalid url)'; }
}
function notificationsView(db) {
  return {
    targets: notifyCfg(db).targets.map(t => ({
      id: t.id, label: t.label || '', type: t.type,
      urlMasked: maskUrl(t.url), events: t.events || [], enabled: t.enabled !== false,
      lastResult: t.lastResult || null, lastAt: t.lastAt || null
    })),
    events: NOTIFY_EVENTS,
    types:  NOTIFY_TYPES
  };
}

app.get('/api/settings/notifications', auth, sessionAdminOnly, apiLimiter, (req, res) => {
  res.json(notificationsView(readDB()));
});

app.post('/api/settings/notifications', auth, sessionAdminOnly, apiLimiter, (req, res) => {
  const b = req.body || {};
  if (!NOTIFY_TYPES.includes(b.type)) return res.status(400).json({ error: `type must be one of: ${NOTIFY_TYPES.join(', ')}` });
  const url = cleanBaseUrl(b.url);
  if (!url) return res.status(400).json({ error: 'A valid http(s) URL is required.' });
  const events = Array.isArray(b.events) ? b.events.filter(e => NOTIFY_EVENTS.includes(e)) : [];
  const db = readDB();
  if (!db.settings.notifications || typeof db.settings.notifications !== 'object') db.settings.notifications = {};
  if (!Array.isArray(db.settings.notifications.targets)) db.settings.notifications.targets = [];
  if (db.settings.notifications.targets.length >= 10)
    return res.status(400).json({ error: 'Maximum of 10 notification targets.' });
  const rec = {
    id: newId('ntf'),
    label: String(b.label || '').trim().slice(0, 60) || b.type,
    type: b.type, url,
    events: events.length ? events : NOTIFY_EVENTS.slice(),
    enabled: b.enabled !== false,
    createdAt: new Date().toISOString()
  };
  db.settings.notifications.targets.push(rec);
  if (!saveDB(db, res, 'add notification target')) return;
  console.log(`[AudioSeerr] Notification target added: ${rec.type} "${rec.label}" (by "${req.user.username}")`);   // never log the URL
  res.status(201).json(notificationsView(db));
});

app.delete('/api/settings/notifications/:id', auth, sessionAdminOnly, apiLimiter, (req, res) => {
  const db = readDB();
  const list = (db.settings.notifications && db.settings.notifications.targets) || [];
  const idx = list.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.sendStatus(404);
  list.splice(idx, 1);
  if (!saveDB(db, res, 'remove notification target')) return;
  res.json(notificationsView(db));
});

// Send a sample notification so the admin can confirm the target works without
// waiting for a real request.
app.post('/api/settings/notifications/:id/test', auth, sessionAdminOnly, apiLimiter, async (req, res) => {
  const db = readDB();
  const t  = ((db.settings.notifications && db.settings.notifications.targets) || []).find(x => x.id === req.params.id);
  if (!t) return res.sendStatus(404);
  const sample = {
    id: 'test', artistName: 'Daft Punk', albumName: 'Discovery',
    username: req.user.username, cover: null, lidarrMessage: 'This is a test from AudioSeerr.'
  };
  const ok = await deliverNotification(t, 'request.created', sample);
  // Record the outcome so the UI can show it without re-testing.
  t.lastResult = ok ? 'ok' : 'failed';
  t.lastAt     = new Date().toISOString();
  try { writeDB(db); } catch { /* non-critical */ }
  res.json({ ok, error: ok ? null : 'Delivery failed — check the URL and the server log.' });
});

// ── Backup / export ────────────────────────────────────────────────────────
// db.json holds password hashes and API keys, so this is admin-session-only and
// deliberately not reachable with a service key.
app.get('/api/backup', auth, sessionAdminOnly, apiLimiter, (req, res) => {
  const db = readDB();
  const redact = req.query.redact !== '0';
  const out = redact
    ? { ...db,
        users:   db.users.map(({ passwordHash, ...u }) => u),
        apiKeys: db.apiKeys.map(k => ({ ...k, key: maskKey(k.key) })) }
    : db;
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="audioseerr-backup-${stamp}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({ app: 'AudioSeerr', version: APP_VERSION, exportedAt: new Date().toISOString(), redacted: redact, data: out }, null, 2));
});

// CSV of the request history — the format people actually want for a spreadsheet.
app.get('/api/requests/export.csv', auth, adminOnly, apiLimiter, (req, res) => {
  const db  = readDB();
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = ['id','createdAt','username','type','artistName','albumName','quality','approvalStatus','status','availableAt','lidarrMessage'];
  const rows = filterRequests(db.requests, req.query)
    .map(r => cols.map(c => esc(c === 'approvalStatus' ? approvalOf(r) : r[c])).join(','));
  res.setHeader('Content-Disposition', `attachment; filename="audioseerr-requests-${new Date().toISOString().slice(0,10)}.csv"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send([cols.join(','), ...rows].join('\n'));
});

// ── Connection settings (Admin → Connections) ──────────────────────────────
// Lets an admin link Lidarr (and optionally Last.fm) from inside the app. The
// values are stored in db.json → settings, so they're permanent and apply to
// every browser/device; anything in .env acts as the fallback. Locked to a
// logged-in ADMIN SESSION (sessionAdminOnly): an external API key can neither
// read nor change these — a leaked service key must not be able to exfiltrate
// the Lidarr API key or repoint AudioSeerr at a hostile server. Saved keys are
// never echoed back — responses only carry a masked tail.
function maskKey(k) {
  if (!k) return null;
  return '••••••••' + String(k).slice(-4);
}
function connectionsView() {
  return {
    lidarr: {
      url:        CONN.lidarrUrl || '',
      keyMasked:  maskKey(CONN.lidarrKey),
      configured: Boolean(CONN.lidarrUrl && CONN.lidarrKey),
      source:     CONN.lidarrSource                       // 'app' | 'env' | 'none'
    },
    lastfm: {
      keyMasked:  maskKey(CONN.lastfmKey),
      configured: Boolean(CONN.lastfmKey),
      source:     CONN.lastfmSource
    },
    env: { lidarr: Boolean(ENV_LIDARR_URL || ENV_LIDARR_KEY), lastfm: Boolean(ENV_LASTFM_KEY) }
  };
}

// Validate an admin-supplied base URL: http(s) only, sane length, no trailing /.
function cleanBaseUrl(raw) {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  if (!v) return '';                                       // '' = clear the override
  if (v.length > 300) return null;
  let u; try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return v;
}

app.get('/api/settings/connections', auth, sessionAdminOnly, apiLimiter, (req, res) => {
  res.json(connectionsView());
});

app.put('/api/settings/connections', auth, sessionAdminOnly, apiLimiter, (req, res) => {
  const body = req.body || {};
  const db   = readDB();
  if (!db.settings.lidarr || typeof db.settings.lidarr !== 'object') db.settings.lidarr = {};
  if (!db.settings.lastfm || typeof db.settings.lastfm !== 'object') db.settings.lastfm = {};

  // Field semantics: present → set it ('' clears the app value, restoring the
  // .env fallback); absent → leave it alone (so the key field can stay blank
  // in the UI without wiping the saved key).
  if (body.lidarr && typeof body.lidarr === 'object') {
    if (body.lidarr.url !== undefined) {
      const u = cleanBaseUrl(body.lidarr.url);
      if (u === null) return res.status(400).json({ error: 'Lidarr URL must be a valid http(s) URL, e.g. http://192.168.1.10:8686' });
      if (u) db.settings.lidarr.url = u; else delete db.settings.lidarr.url;
    }
    if (body.lidarr.apiKey !== undefined) {
      const k = String(body.lidarr.apiKey || '').trim();
      if (k.length > 200) return res.status(400).json({ error: 'Lidarr API key looks too long.' });
      if (k) db.settings.lidarr.apiKey = k; else delete db.settings.lidarr.apiKey;
    }
    db.settings.lidarr.updatedAt = new Date().toISOString();
  }
  if (body.lastfm && typeof body.lastfm === 'object') {
    if (body.lastfm.apiKey !== undefined) {
      const k = String(body.lastfm.apiKey || '').trim();
      if (k.length > 100) return res.status(400).json({ error: 'Last.fm API key looks too long.' });
      if (k) db.settings.lastfm.apiKey = k; else delete db.settings.lastfm.apiKey;
    }
    db.settings.lastfm.updatedAt = new Date().toISOString();
  }

  if (!saveDB(db, res, 'save connections')) return;
  refreshConn(db);          // apply immediately — no restart needed
  invalidateLibCache();     // the library cache may belong to the old server
  clearLidarrMemo();        // status/queue/config memos too — same reason
  clearForYouCache();       // "For You" rows were seeded from the old library
  console.log(`[AudioSeerr] Connections updated by "${req.user.username}" (lidarr: ${CONN.lidarrSource}, lastfm: ${CONN.lastfmSource})`); // never log key material
  res.json(connectionsView());
});

// Test a Lidarr connection WITHOUT saving. Uses the supplied url/key when
// given, falling back to the currently effective values — so an admin can test
// a new URL against the already-saved key (which the browser never sees).
app.post('/api/settings/lidarr/test', auth, sessionAdminOnly, apiLimiter, async (req, res) => {
  const body = req.body || {};
  const rawUrl = (body.url !== undefined && String(body.url).trim() !== '') ? body.url : CONN.lidarrUrl;
  const url    = cleanBaseUrl(rawUrl);
  const key    = (body.apiKey && String(body.apiKey).trim()) || CONN.lidarrKey;
  if (url === null) return res.status(400).json({ error: 'Lidarr URL must be a valid http(s) URL.' });
  if (!url || !key) return res.json({ ok: false, error: 'A Lidarr URL and API key are both needed — enter them above (or set them in .env).' });
  try {
    const s = await httpRequest(`${url}/api/v1/system/status`, {
      headers: { 'X-Api-Key': key, 'Accept': 'application/json' },
      timeout: 8000
    });
    if (!s || typeof s !== 'object' || !s.version)
      return res.json({ ok: false, error: 'That URL answered, but not with a Lidarr system/status payload — check the address and that it is Lidarr (not Sonarr/Radarr).' });
    res.json({ ok: true, version: lidarrVersion(s) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── SPA fallback ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.sendStatus(404);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error net ──────────────────────────────────────────────────────────────
// Express 4 routes SYNCHRONOUS throws here; without this the default handler
// answers with an HTML stack trace. Must be registered after every route.
app.use((err, req, res, next) => {                              // eslint-disable-line no-unused-vars
  console.error('[AudioSeerr] Unhandled error on', req.method, req.originalUrl, '—', err.message);
  if (res.headersSent) return;
  // A data-store failure is the operator's problem to fix, and the message is
  // actionable ("db.json is not valid JSON…"), so surface it as a 503 rather
  // than burying it in a generic 500.
  if (/db\.json|Data store|Cannot read .*db/i.test(err.message || '')) {
    return res.status(503).json({ error: err.message });
  }
  res.status(err.status || 500).json({ error: IS_PROD ? 'Internal server error.' : err.message });
});

// Express 4 does NOT catch rejections from async handlers, and Node's default
// for an unhandled rejection is to terminate — so one failed db write used to
// kill the process and, with restart:unless-stopped, crash-loop the container.
// Log and keep serving instead; the request itself is already lost.
process.on('unhandledRejection', err => {
  console.error('[AudioSeerr] Unhandled promise rejection:', err && err.stack || err);
});
// Log-and-continue is right for a stray exception in one request, but NOT for a
// startup-fatal error: swallowing EADDRINUSE would leave a process alive that
// is not listening on anything, which looks healthy and serves nothing.
const FATAL_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);
process.on('uncaughtException', err => {
  console.error('[AudioSeerr] Uncaught exception:', err && err.stack || err);
  if (!listening || FATAL_CODES.has(err && err.code)) {
    console.error('[AudioSeerr] Fatal during startup — exiting.');
    process.exit(1);
  }
});

// Clean shutdown so Docker stop/restart doesn't sever in-flight writes.
let server;
let listening = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[AudioSeerr] ${sig} — shutting down.`);
    if (server) server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

server = app.listen(PORT, () => {
  listening = true;
  console.log(`\n🎵 AudioSeerr v${APP_VERSION}  →  http://0.0.0.0:${PORT}`);
  console.log(`   Lidarr : ${lidarrUrl()||'(not linked — Admin → Connections, or LIDARR_URL in .env)'} [${CONN.lidarrSource}]`);
  console.log(`   Last.fm: ${lastfmKey() ? `configured [${CONN.lastfmSource}]` : '(optional — Admin → Connections, or LASTFM_API_KEY in .env)'}\n`);
});
server.on('error', err => {
  console.error(`[AudioSeerr] FATAL: could not bind port ${PORT} — ${err.message}`);
  process.exit(1);
});

// Warm the library cache in the background. On a large Lidarr the dump takes
// minutes, so doing it now means the first person to open Discover gets badges
// immediately instead of triggering the cold fetch themselves. Fire-and-forget:
// a failure just leaves the normal on-demand path to retry.
if (lidarrUrl() && lidarrKey()) {
  setTimeout(() => {
    refreshLibrary().catch(() => {});
  }, 2000).unref();
}
