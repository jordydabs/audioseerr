# Changelog

All notable changes to AudioSeerr are documented here. Release notes for each
version are also published on the
[Releases page](https://github.com/jordydabs/audioseerr/releases).

## [2.10.1] - 2026-10-31

The Docker image moves off end-of-life base images. Only the `Dockerfile` and the
docs that name its base change — no application code, configuration or data
format.

### Upgrade notes

- **Rebuild the image.** `docker compose up -d --build` (the quick-start
  command) does it. If you keep an older `docker-compose.yml` whose image tag is
  still `audioseerr:2.10.0`, a plain `docker compose up -d` reuses that existing
  image and keeps running the old base.
- **32-bit ARM hosts (armv6/armv7) can no longer build the image.** The
  `node:24-alpine` images are published for amd64, arm64 and s390x only. On a
  32-bit Raspberry Pi, change both `FROM` lines in the `Dockerfile` to
  `node:22-alpine3.24` (Node.js 22 is supported until 2027-04-30).
- Nothing changes in `.env` or `./data`; `docker-compose.yml` only gets the new
  image tag.

### Security

- **The image no longer builds on end-of-life base images.** The `Dockerfile`
  pinned `node:20-alpine3.20`. Node.js 20 reached end-of-life on 2026-04-30 and
  Alpine 3.20 on 2026-04-01, and that tag was last rebuilt in May 2025 — so the
  image shipped Node.js 20.19.2, three security releases behind the last 20.x,
  on an Alpine that no longer gets fixes. That undercut the hardened, scannable
  image the README promises. Both build stages now use `node:24-alpine3.24`:
  Node.js 24 LTS (supported until 2028-04-30) on Alpine 3.24 (supported until
  mid-2028). It is still a pinned tag, not `:latest`, and the `Dockerfile`
  header now says where to re-check the support schedules.

### Internal

- When `npm ci` cannot download its dependencies (seen behind a
  TLS-intercepting proxy), the build now fails instead of finishing with an
  empty `node_modules`: npm 10.8.2 on the old base exited 0 after the failure,
  while npm 11 exits non-zero with the underlying error.

## [2.10.0] - 2026-10-23

A full security, correctness and integration review. Two of the fixes below are
things that could lose your data or hand out admin access, so **upgrading is
strongly recommended**.

### Upgrade notes

- **Set `JWT_SECRET` and `ADMIN_PASS` in `.env` before starting.** Both now ship
  blank in `.env.example` and production refuses to boot without `JWT_SECRET`,
  or without `ADMIN_PASS` while the admin account still has to be created (see
  the first two Security items — the old guard caught neither the sample
  `JWT_SECRET` it shipped with nor a blank `ADMIN_PASS`). An existing install
  already has its admin, so it may leave `ADMIN_PASS` blank or unset; a sample
  value such as `changeme` is still refused.
- Existing browser sessions keep working. Changing a password or a user's role
  now signs other devices out, which it previously did not.
- `mem_limit` in `docker-compose.yml` was raised from 256m to 384m.
- No database migration is needed. Two one-time repairs run automatically at
  boot: request rows are re-linked to their owner by id, and any users sharing
  an id are reported in the log.

### Security

- **The weak-secret guard did not match the secret the project shipped with.**
  `checkSecrets()` compared `JWT_SECRET` against one literal, but `.env.example`
  contained a *different* 36-character placeholder — so it passed both the
  equality check and the 32-character length check. Anyone who copied
  `.env.example` and changed only `ADMIN_PASS` (the only value the error message
  named) ran a production instance signing tokens with a key published in this
  repository. Because authorization trusted the token's own `role` claim, that
  meant unauthenticated full admin. The guard now matches every known sample,
  anything that still reads like a placeholder, and reports each failing value
  by name.
- **A blank `ADMIN_PASS` passed the production guard and left an admin nobody
  could log in as.** `.env.example` ships `ADMIN_PASS=` blank, and an empty
  string is neither the `changeme` default nor a placeholder, so anyone who
  filled in only `JWT_SECRET` booted normally — with an admin created from the
  hash of an empty password, which login rejects. That account is only created
  when no user of that name exists, so setting `ADMIN_PASS` afterwards changed
  nothing. Production now refuses to start, naming `ADMIN_PASS`, when it is
  unset, blank or whitespace-only (an empty `ADMIN_PASS_FILE` included) and the
  admin has yet to be created; existing installs are unaffected. Outside
  production it is a loud warning and the account gets the sample password
  `changeme`, as it always did when unset. Already hit this? Delete the `admin`
  entry from `data/db.json` (or the file, on a fresh install) and restart.
- **Sessions are now revocable.** Tokens were verified but never checked against
  the database, so demoting an admin or deleting an account changed nothing
  until the (up to 365-day) token expired. Identity and role are re-resolved on
  every request, and a `tokenVersion` is bumped by password changes, role
  changes and admin password resets. Deleting an account invalidates its tokens
  immediately. `SESSION_DAYS` makes the window configurable.
- **`GET /api/summary` leaked the whole instance to any logged-in user** —
  every user's request history, their usernames (the `search` filter matched on
  username, making it an enumeration oracle), and the account and API-key
  counts. It is now scoped to the caller; admins and API keys still see
  everything. The `limit` parameter is also capped.
- **Fixed an XSS in the artist/album tiles.** Artwork fallbacks were built as
  `onerror="this.src='...'"` with a URL interpolated into the JS string.
  `encodeURIComponent` deliberately leaves apostrophes intact, so an artist or
  album name containing one closed the string and the remainder was parsed as
  JavaScript — and names come straight from third-party catalogues. Replaced
  with a single delegated listener and a `data-` attribute. (HTML-escaping alone
  would not have fixed this: the parser decodes the attribute before the handler
  is compiled.)
- Outbound requests no longer forward `X-Api-Key`, `Authorization` or `Cookie`
  across a redirect to a different origin, and relative redirects keep the port.
- Lidarr's self-reported version is sanitised server-side and escaped
  client-side before being rendered into every user's sidebar.
- Server error messages built from upstream response bodies are escaped before
  reaching the DOM, and no longer splice raw upstream content into stored
  request records.
- Cover-art URLs supplied by a client are validated to `http(s)` before being
  stored and rendered in the admin's browser.
- `POST /api/lidarr/search` is admin-only. It fired real indexer searches while
  bypassing `canRequest`, daily limits and the approval queue.
- API keys are compared in constant time; failed logins run a dummy bcrypt
  compare so response timing does not reveal whether an account exists.
- `GET /api/users` requires an admin *session* (not a service key), matching the
  other user routes. Rate limiting now covers the user, key and settings routes.
- Passwords have a minimum length on create and admin reset; usernames are
  validated and length-limited.
- Internal Lidarr host/port detail in connection errors is shown to admins only.
- Production dependencies are patched so `npm audit` reports no findings:
  `proxy-addr` (critical — IP spoofing via IPv4-mapped IPv6 addresses and trusted
  subnets; it is the library behind `TRUST_PROXY`), `body-parser` (high — DoS via
  trailing bytes after a compressed request body) and `qs` (moderate — three DoS
  issues). All are lockfile-only updates within the existing version ranges.

### Data integrity

- **`readDB()` turned any filesystem error into an empty database**, which the
  next write persisted — silent, total data loss. A hand-edited `db.json` with a
  syntax error, a file truncated by a crash, or an `EACCES` after a `chown` all
  hit the same path. Only a genuinely missing file is treated as empty now;
  everything else fails loudly with an actionable message and the file is left
  untouched. `writeDB` refuses to write a database that was never read, keeps a
  `.bak` generation, and `fsync`s both the file and the directory.
- **A failed save no longer kills the process.** Express 4 does not catch
  rejected promises from `async` handlers and Node terminates on an unhandled
  rejection, so one failed write crash-looped the container. Handlers are
  wrapped at registration, there is a JSON error handler, and process-level
  guards log instead of exiting (while still exiting on a fatal startup error).
- Record ids are collision-resistant. `'req_' + Date.now()` collided for
  requests created in the same millisecond, and every lookup takes the first
  match — so approve/reject/delete could act on the wrong row and leave the real
  one permanently stuck.
- The bootstrap admin no longer hardcodes the id `admin_001`. Changing
  `ADMIN_USER` deterministically created a second user with the same id, which
  then silently operated as the first and could never be edited or deleted.
- Ownership is decided by user id alone. Matching the denormalised `username`
  let a recreated namesake — or an API key whose label happened to equal a real
  username — inherit read and delete rights over another account's requests.
- The daily request limit reserves its slot before the Lidarr round-trip, so
  concurrent requests can no longer all pass the same pre-increment check.
- A daily limit of `0` is honoured instead of being silently rewritten to 10
  (the form offers `min="0"`), and negative values no longer lock an account out
  with "Daily limit reached (-1/day)".
- **A failed auto-approve is no longer a dead end.** It was stored as
  approved+error, which the approve route rejected as already-approved and the
  reject route rejected as not-pending — leaving Delete as the only option. It
  is now stored as pending and retriable, like a failed approval.
- **A failed approval of a rejected request no longer destroys the rejection.**
  The row was unconditionally rewritten to pending, discarding the reason,
  reviewer and timestamp for an operation that had failed. State is restored and
  the error recorded separately.
- Cache invalidation is fenced by a generation counter, so a library dump
  already in flight from the *previous* Lidarr cannot repopulate the cache after
  a connection change and make every subsequent add short-circuit to "already in
  library".
- Deleting a user removes their orphaned requests and preferences.

### Upstream integration

- **`httpRequest` could hang forever.** There was no `res.on('error')` handler,
  so a socket reset after headers left the promise unsettled — which
  permanently stuck the single-flight latches and leaked the Deezer concurrency
  semaphore until restart, disabling every Deezer-backed feature.
- **Response bodies are decoded once, not per chunk.** `raw += chunk` decoded
  each Buffer independently, so a UTF-8 sequence split across a TCP read became
  `U+FFFD` on both sides. `JSON.parse` still succeeded, so artist names silently
  corrupted — and a corrupted name never matches the library, breaking
  in-library checks on exactly the large responses the app depends on.
- A `200` carrying non-JSON is treated as an error instead of being accepted,
  which used to produce a green "Lidarr v?" badge and an empty-but-valid library
  cache that disabled in-library badging for five minutes.
- Responses are size-capped, and every request has an independent deadline.
- MusicBrainz calls are serialised to its published 1 req/sec limit, cached for
  10 minutes, and send a contactable User-Agent carrying the real version and a
  link to this repository (the contact URL had pointed at `audioseerr/audioseerr`
  instead of `jordydabs/audioseerr`). iTunes Search calls from Mood Discovery are
  paced too.
- `/api/lidarr/queue` clamps `limit` at both ends. A negative value passed
  straight through to Lidarr and, being part of the memo key, let any caller
  mint unbounded cache entries that each bypassed the memo.
- Transient upstream failures are no longer cached as permanent empty results
  (a 12-hour negative cache meant one bad minute emptied "For You" for half a
  day).
- MusicBrainz ids are matched first-wins; the previous one-liner kept the
  *last* duplicate, attaching the lowest-relevance same-name artist's id.
- `/api/discover/lastfm` and `/api/discover/itunes` use their base-URL constants
  instead of hardcoded hosts.

### Added

- **Album requests actually add albums.** Every request — artist or album — used
  to be turned into an artist add, and if the artist was already in the library
  the add short-circuited before doing anything. So requesting a second album by
  an artist you already own resulted in *nothing happening in Lidarr* while the
  request was recorded as delivered. An album request now monitors that album,
  creating the artist alongside it (unmonitored) when needed so a single-album
  request does not pull in a whole discography.
- **Fulfilment tracking.** Requests progress to **Downloading** and then
  **Available**, stamped with `availableAt`. The sweep rides on library data
  AudioSeerr already caches, so it costs Lidarr nothing extra. Adds an Available
  counter tile and status filter.
- **Download Activity page** consuming the queue endpoint that existed since 2.7
  but which nothing in the UI ever called: progress, indexer, time remaining,
  stalled/failed grabs highlighted, and admin removal of a stuck item.
- **Outbound notifications** to Discord, ntfy, Gotify or any JSON webhook, on
  request created / pending / approved / rejected / available. Delivered
  server-side, so nobody needs a browser open — the old in-app popups fired for
  admins only, every 20 seconds, and only while a visible tab was open. No new
  npm dependency.
- **Root folder and metadata profile selection.** Both were hardcoded to
  whatever Lidarr listed first, so on a multi-root setup every add landed in
  root #0. The requested quality profile is now validated against Lidarr too.
- **Deep-link routing.** Pages are addressable (`/search`, `/downloads`, …), so
  bookmarks, shared links, reload and browser Back work — and the Android back
  gesture no longer exits the installed PWA. The intended destination survives
  the login redirect.
- **Backup, CSV export and retention.** Download a redacted `db.json` or a CSV of
  the request history, and optionally prune settled requests by age or count
  (pending and in-progress rows are never touched).
- Reject-with-reason in the UI (the server already stored one; nothing collected
  it), the running version in the sidebar, and Escape to close any modal.

### Fixed (UI)

- Navigation highlighting applied to the hidden mobile button instead of the
  visible sidebar item, so after the first click nothing looked selected.
- Enter in the search box ran the search **twice** — an inline handler
  duplicated one `initSearchSuggest()` already installed, causing two API calls
  and a render race.
- Search had no request-sequence guard, so a slower earlier response could
  overwrite a newer one; in-library badging captured its tile list before an
  await and indexed into detached nodes.
- The in-library cache recorded lookup failures and "Lidarr not configured" as a
  definitive *not in library*, permanently disabling badging for the session.
- Album tiles were blocked by an artist-level in-library check, which made
  requesting another album by an artist you own impossible from the UI.
- The slider stepped by a hardcoded 191px against a real 187px pitch and
  over-scrolled past the end; it now measures and handles resize.
- Sidebar navigation was non-focusable `<div>`s, unreachable by keyboard on
  desktop. The Lidarr match rows and quality options were likewise
  click-only. All are now proper controls with keyboard and ARIA support.
- "New & Upcoming Releases" was fed by Apple's *most-played* chart — the same
  payload as Trending Albums, so both rows rendered identical tiles and nothing
  in the section was actually new. It now uses the *most-recent* feed
  (`APPLE_STOREFRONT` selects the country).
- Album request confirmations say what actually happened instead of always
  claiming the album was sent.
- "For You" explains why it is empty instead of silently hiding itself.
- Switching Artists↔Albums no longer leaves the previous type's results on
  screen.

### Removed

- `xfetch()` in `public/app.js` — defined, never called.
- The dead "default the quality profile to Standard" patch, whose selector could
  never match what the app renders (a `MutationObserver` running on every
  mutation to do nothing). The app already prefers a profile named "Standard".
- The duplicate Enter-to-search handler described above.
- An orphan `.req-status` CSS rule for a class the table never renders.

### Internal

- Dependencies updated — Express 4.19.2 → 4.22.3 (fixes a `res.redirect` XSS and
  a `path-to-regexp` ReDoS), plus helmet, express-rate-limit, jsonwebtoken and
  dotenv. `package-lock.json` is now committed, so the Docker build takes the
  `npm ci` path and is actually reproducible; previously no lockfile existed and
  every build silently resolved fresh transitive dependencies.
- The Dockerfile no longer duplicates the whole app tree in a `chown` layer, and
  application code is not writable by the user that runs it. `PORT` is honoured
  by `EXPOSE` and the healthcheck.
- The commented-out Docker-secrets block in `docker-compose.yml` produced a
  duplicate `environment:` key if uncommented as written.
- A `TRUST_PROXY` value Express could not parse (`true`, a hostname) threw at
  module load and killed the process before it listened, with a stack trace that
  never named the variable.
- The parsed database is cached and validated with `stat()`, which matters now
  that every authenticated request resolves its caller against it.
- `README.md` corrected throughout: version drift across three places, a quick
  start advertising a login the shipped config makes impossible, a
  reverse-proxy snippet that turned every admin route into an unauthenticated
  API, an overstated mood list, and the search provider description.

[2.10.1]: https://github.com/jordydabs/audioseerr/releases/tag/v2.10.1
[2.10.0]: https://github.com/jordydabs/audioseerr/releases/tag/v2.10.0
