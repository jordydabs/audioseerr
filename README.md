https://github.com/user-attachments/assets/e311c7ce-89c9-4358-93e3-48064f93d8b8

<div align="center">

<img src="public/icon-192.png" alt="AudioSeerr logo" width="96" height="96">

# AudioSeerr

**A self-hosted music request manager for [Lidarr](https://lidarr.audio/).**

Browse new and trending music, search across multiple metadata providers, and send artist and album requests straight to Lidarr — with per-user accounts, request limits, approvals, API keys, and a dashboard-ready summary endpoint.

[![Version](https://img.shields.io/github/package-json/v/jordydabs/audioseerr?label=version&color=f5a623)](https://github.com/jordydabs/audioseerr/releases/latest)
[![Node](https://img.shields.io/badge/node-20--alpine-339933?logo=node.js&logoColor=white)](Dockerfile)
[![Docker Compose](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE)

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration) · [API](#api-access) · [Security](#security) · [Changelog](CHANGELOG.md)

</div>

https://github.com/user-attachments/assets/de7a212e-6918-4e3f-be31-b0af29c0d756

---

## Overview

AudioSeerr is a lightweight request frontend for Lidarr. Users browse or search for music, hit **Request**, and the artist is added to Lidarr with full-discography monitoring and an automatic search kicked off. Think of it as an Overseerr-style experience for your music library.

It runs as a single small Node/Express app with a flat-file (`db.json`) database — no external database to manage — and ships hardened for Docker out of the box.

## Features

### Discover

- **New & Trending** — the landing tab: new releases, upcoming albums, and trending artists pulled from **Last.fm**, **Deezer**, and **iTunes**, with an independent source dropdown per section.
- **Mood Discovery** — drop in a few seed artists and/or genres, or pick a vibe, and get fresh artists that fit *all* the terms together. It searches **every catalogue at once** — Deezer and iTunes (keyless) plus **Last.fm** when a key is set — with *no LLM required*. Micro-genres (*dub techno*, *phonk*, *vaporwave*, …) are first-class, and every result carries a "why" line. See *How Mood Discovery works* below.
- **For You** — Mood Discovery opens with "Because you have *\<artist\>*" rows seeded from random artists in your Lidarr library, powered by Deezer similar-artist data (Last.fm fallback), with everything you already own filtered out. A Shuffle button picks fresh seeds. Rows are cached 30 minutes and per-seed lookups 12 hours, so repeat visits and shuffles cost almost nothing upstream.
- **Top Artists of All Time** — a dedicated slider of artists that are durably among the most-played of all time, served from a curated list (cover art resolved via Deezer, no API key required) so there's always a starting point beyond this week's charts. The list lives in `ALLTIME_ARTISTS` in `server.js` and is easy to edit.
- **Search** — artists via Deezer (fast, always has artwork) with MusicBrainz for coverage of the obscure tail; albums via MusicBrainz. Then pick the exact Lidarr match before requesting.
- **Library-aware everywhere** — Search results *and* every New & Upcoming tile (Trending, All-Time, New Releases) are checked against your Lidarr library in real time. Anything you already have is badged **📚 In Library** and dimmed, and trying to request it shows an *"already in library"* popup instead of creating a duplicate.

<details>
<summary><b>🎛️ How Mood Discovery works</b></summary>

- **Every catalogue at once** — Deezer and iTunes (keyless) plus Last.fm when a key is set. Last.fm is optional: without a key it simply runs on Deezer + iTunes.
- **Similarity** comes from Deezer's "fans also like" (expanded a hop deeper for lesser-known acts), **Deezer playlist co-occurrence** (artists that curators file next to your seeds), and Last.fm's similar-artist graph.
- **Moods and genres mine curated playlists directly** — a *chill* query reads real chill playlists, not just genre charts — so mood queries work well even without a Last.fm key.
- **Micro-genres are first-class** — type *dub techno*, *phonk*, *breakcore*, *vaporwave*, … and artists curated under that exact term outrank generic family-chart names. Unrecognized words aren't dropped; they become free-text style searches (*night drive* finds synthwave curation).
- **Cross-checked ranking** — each finalist's real genre is read from its Deezer releases and cross-checked against Last.fm tags and iTunes' genre. The more catalogues agree, the higher it ranks, and mood biases toward deeper, less-mainstream finds.
- **Explainable results** — every result gets a representative album and a "why" line (*Electronic · similar to Aphex Twin*, *Curated in dub techno playlists*, …).
- **Rate-limit safe** — all Deezer traffic is paced through a global rate limiter with automatic quota retry, so big queries can't silently lose results to Deezer's request quota.
- **Moods** — chill, energetic, focus, melancholic, party, experimental, **romantic** and **dark** (synonyms like *workout*, *sad* or *lo-fi* map onto them).

</details>

### Request & fulfil

- **Artist *and* album requests** — an artist request adds the artist (monitoring scope is configurable). An album request adds and monitors **that album** in Lidarr, including for an artist you already own.
- **Request approvals (Overseerr-style)** — a global **Auto-approve all requests** switch (Admin → Request Approvals):
  - **ON (the default):** every request goes straight to Lidarr.
  - **OFF:** requests from regular users are parked as **🕓 Pending approval** in All Requests, where the admin can **✓ Approve** (sends to Lidarr) or **✕ Reject** each one.
  - **Exceptions:** flag any user *Auto-approve* in Manage Users to skip the queue; admins and API keys are always auto-approved.
  - **Failures are retriable:** if a Lidarr send fails during approval, the request stays pending (with the error shown) so it can simply be approved again once Lidarr is reachable — and a rejected request can still be approved later.
  - A gold counter on the All Requests nav item shows how many are waiting, and All Requests opens with **Total / Approved / Pending / Rejected** counter tiles right above the table — tap one to filter to that state.
- **Fulfilment tracking** — requests don't stop at "sent". A throttled sweep (riding on the library data AudioSeerr already caches, so it costs Lidarr nothing extra) promotes them to **⬇️ Downloading** and then **🎉 Available** when the files actually land, and stamps when that happened. There's an Available counter tile and status filter to match.
- **Download Activity** — a live view of Lidarr's download queue with progress bars, indexer, time remaining, and stalled/failed grabs highlighted. Admins can remove a stuck item. Served from a 15-second memoised read, so any number of open browsers cost Lidarr at most four queue reads a minute.
- **Outbound notifications** — send request created / pending / approved / rejected / available events to **Discord, ntfy, Gotify, or any JSON webhook**. Delivered server-side, so nobody needs a browser open. No extra npm dependency; add targets under Admin → Notifications and hit **Send test**.

### Admin & users

- **User management** — per-user accounts with configurable daily request limits and an enable/disable toggle.
- **Self-service passwords** — every user can change their own password (🔑 button); admins can reset anyone's from the Users page.
- **API keys** — generate full-access service-account keys so other programs and dashboards can connect (Admin → API Access).
- **In-app Lidarr setup** — link Lidarr (URL + API key) and Last.fm straight from **Admin → Connections**, with a one-click connection test. Saved server-side in `db.json`, applied instantly (no restart), synced to every browser/device; `.env` remains a fallback and app values override it.
- **Live quality profiles** — quality profiles are pulled straight from your Lidarr instance; no hardcoding.
- **Backup, CSV export & retention** — download a redacted `db.json` backup or a CSV of the request history, and optionally prune settled requests by age or count (pending and in-progress rows are never touched).
- **Server-synced preferences** — UI choices (per-section discover source, the admin "new request seen" marker) are stored server-side per user, so they persist and follow you across browsers and devices. The seen marker is *monotonic* (it can only advance) and viewing All Requests marks them seen everywhere — checking requests on your desktop stops your phone from re-announcing them, and vice versa.
- **Mobile-first requests view** — on phones the requests tables render as compact cards (cover · title · status · delete) instead of a sideways-scrolling 8-column table.

### Integration & operations

- **Lidarr-friendly by design** — AudioSeerr is aggressively polite to Lidarr:
  - Status/queue reads are memoised (15s) with single-flight de-duplication, so a dashboard polling `/api/summary` every few seconds costs Lidarr at most a few requests per minute.
  - The expensive full-library dump behind in-library badging is cached 45 minutes with stale-while-revalidate (and given a 5-minute timeout, because a large Lidarr can take minutes to answer it); adds are spliced into the cache instead of forcing refetches; profiles/root-folders are cached 60s.
  - **Failures are backed off** — a slow or downed Lidarr is never hit with a retry storm.
  - An admin-tunable **Lidarr add behaviour** (Connections card) chooses what each add monitors (all albums / latest / future / nothing) and whether Lidarr starts searching indexers immediately. See [What an add costs Lidarr](#what-an-add-costs-lidarr-and-how-to-tune-it).
- **Dashboard summary endpoint** — one call to `/api/summary` returns Lidarr status, the download-queue count, request tallies, and recent requests for dashboard tiles (Organizr, Homepage, etc.). See [Dashboard integration](#dashboard-integration).
- **Health endpoint** — unauthenticated `/api/health` for Docker / uptime monitors.
- **Embeddable** — sends no `X-Frame-Options` and uses a `frame-ancestors *` CSP, so the whole UI drops into an `<iframe>` from any dashboard.
- **Hardened container** — non-root user, dropped Linux capabilities, read-only root filesystem, isolated network, and resource limits. See [Security](#security).

## Project layout

```
audioseerr/
├── server.js                # Express backend
├── package.json
├── package-lock.json
├── Dockerfile
├── docker-compose.yml
├── .env                     # your config (never commit this)
├── .env.example
├── .github/                 # issue forms + the Release workflow
├── CHANGELOG.md
├── SECURITY.md
├── LICENSE
├── docs/
│   └── releases/            # release notes — one file per GitHub release
└── public/                  # frontend — served by Express
    ├── index.html
    ├── login.html
    ├── app.js
    ├── style.css
    ├── favicon.svg
    ├── icon-180.png         # apple-touch-icon (iOS home screen)
    ├── icon-192.png         # PWA / Android icon
    ├── icon-512.png         # PWA / Android splash icon
    └── manifest.webmanifest # installable web-app manifest
```

> **Add to Home Screen:** AudioSeerr ships a web manifest and Apple touch icon, so on a phone you can "Add to Home Screen" and get a real app icon (not a blank tile) that opens standalone. The emoji throughout the UI use an explicit colour-emoji font stack, so no square/tofu glyphs on Android, iOS, Windows, or Linux.

> The frontend files **must** live in `public/` — the server serves static assets from that folder.

## Quick start

**Requirements:** a running [Lidarr](https://lidarr.audio/) instance, and either Docker with Compose (recommended) or Node.js 18+.

### Docker (recommended)

```bash
# 1. Clone
git clone https://github.com/jordydabs/audioseerr.git
cd audioseerr

# 2. Configure  — REQUIRED, the container will not start otherwise
cp .env.example .env
#    Set JWT_SECRET and ADMIN_PASS. Both ship blank on purpose:
#      openssl rand -hex 32   →   paste into JWT_SECRET
#      ADMIN_PASS=<your admin password>
#    Optionally set LIDARR_URL / LIDARR_API_KEY here — or leave them out and
#    link Lidarr from inside the app later (Admin → Connections).

# 3. The container runs as a non-root user (uid 1000), so make the
#    data dir writable by it (first run only):
mkdir -p ./data && sudo chown -R 1000:1000 ./data

# 4. Build & run
docker compose up -d --build

# Open http://localhost:7575   ·   log in with the ADMIN_USER / ADMIN_PASS you set in .env
```

Prefer not to chown a host directory? The bottom of `docker-compose.yml` has a commented Docker-managed named-volume option (which Docker owns correctly for you), including a one-time data-migration command.

### Bare metal

```bash
npm ci
cp .env.example .env
#  set JWT_SECRET + ADMIN_PASS, and change DATA_DIR=/app/data to DATA_DIR=./data
npm start                     # http://localhost:7575
```

## Configuration

| Variable         | Required | Description                                         |
|------------------|----------|-----------------------------------------------------|
| `LIDARR_URL`     | No*      | `http://your-lidarr:8686` — or set in Admin → Connections |
| `LIDARR_API_KEY` | No*      | Lidarr → Settings → General — or set in Admin → Connections |
| `LASTFM_API_KEY` | No       | From last.fm/api — or set in Admin → Connections     |
| `ADMIN_USER`     | No       | Default: `admin`                                     |
| `ADMIN_PASS`     | **Yes**  | Password for the bootstrap admin (first start only). Production refuses to boot on a sample value, or on a blank one while the admin doesn't exist yet |
| `JWT_SECRET`     | **Yes**  | 32+ random chars — `openssl rand -hex 32`. Production refuses to boot without it |
| `NODE_ENV`       | No       | Set `production` to enforce strong secrets           |
| `TZ`             | No       | Timezone for daily-limit resets (e.g. `UTC`)         |
| `TRUST_PROXY`    | No       | Set `1` (or an IP/CIDR list, or `loopback`) behind a reverse proxy so rate limits see real client IPs |
| `SESSION_DAYS`   | No       | Browser session length, 1–365 (default `365`)         |
| `APPLE_STOREFRONT` | No     | Country code for the Apple trending/new-release feeds (default `us`) |
| `LIDARR_LIBRARY_TIMEOUT_MS` | No | How long to wait for Lidarr's full artist list (default `300000`) |
| `LIDARR_LIBRARY_TTL_MS` | No | How long that list is cached (default `2700000`, 45 min) |
| `DATA_DIR`       | No       | Docker: `/app/data` · bare metal: `./data`           |
| `PORT`           | No       | Default: `7575`                                      |

\* Lidarr can be configured either in `.env` **or** from inside the app (**Admin → Connections**, stored in `db.json`). App-saved values override `.env` and apply immediately without a restart.

Every sensitive variable also accepts a **`*_FILE`** form (e.g. `JWT_SECRET_FILE`) that points at a file holding the value — for Docker secrets and vault integrations. The `*_FILE` form takes precedence if both are set.

In `NODE_ENV=production`, AudioSeerr **refuses to start** if `JWT_SECRET` is empty, shorter than 32 characters, or any sample/placeholder value, or if `ADMIN_PASS` is a sample/placeholder value. `ADMIN_PASS` must also be set — an empty, unset or whitespace-only value is rejected — whenever the admin account doesn't exist yet (a fresh data directory, or a changed `ADMIN_USER`). It is only read to create that account, so once the admin exists an install can leave it blank or remove it; an `ADMIN_PASS` shorter than 8 characters just logs a warning. Set both in `.env` before your first `docker compose up`, or the container will restart-loop (the reason is in `docker compose logs`).

## How requests work

1. A user finds music via **New & Trending**, **Mood Discovery**, or **Search**.
2. AudioSeerr checks the result against your Lidarr library. An **artist** you already have is badged and can't be re-requested; an **album** by an artist you already have can still be requested, because that's the normal case.
3. On request, the user picks the exact Lidarr artist/album match and a quality profile.
4. **Approval gate** — if *Auto-approve all requests* is ON (default), or the requester is an admin / API key / a user flagged Auto-approve, the request proceeds immediately. Otherwise it's saved as **Pending approval** and waits in All Requests for the admin to approve or reject it. Pending requests still count against the user's daily limit.
5. On approval (or immediately, when auto-approved):
   - an **artist** request adds the artist, using the monitoring scope and search-on-add setting from *Lidarr add behaviour*;
   - an **album** request adds/monitors **that album**. If the artist isn't in Lidarr yet it's created alongside the album (unmonitored, so a single-album request doesn't pull in a whole discography); if the artist is already there, the album is monitored under it and searched.
   - If Lidarr rejects the add, the request stays **pending and retriable** rather than becoming a dead end — an admin just hits Approve again once Lidarr is reachable.
6. The request is logged and visible in **My Requests** and **All Requests**, and progresses to **⬇️ Downloading** and **🎉 Available** on its own as Lidarr actually fetches the music.

### Large libraries

AudioSeerr reads your whole Lidarr artist list to badge what you already own, to keep Mood Discovery from suggesting it, and to notice when a request has actually landed. On a big library that read is slow — Lidarr aggregates per-artist statistics across every track before it sends anything. Measured on a 1,513-artist / 1.1M-track library: **~17 MB and ~240 seconds** on a cold Lidarr cache (about 3 seconds once warm).

That list is fetched with a 5-minute timeout and cached for 45 minutes. Adds are spliced straight into the cache, so the long cache does **not** make the *In Library* badges stale. If `docker compose logs audioseerr` shows:

```
[Lidarr] library fetch failed ... Timeout
```

raise `LIDARR_LIBRARY_TIMEOUT_MS`. When it succeeds you'll see how long it took and when the next refresh is due:

```
[Lidarr] library cached: 1513 artists in 6s (next refresh in 45 min)
```

While that fetch is failing, in-library badges, Mood Discovery's owned-artist filter, *For You* and fulfilment tracking all quietly do nothing — so it's worth fixing rather than ignoring.

### What an add costs Lidarr (and how to tune it)

Adding an artist is the one genuinely heavy thing this app asks of Lidarr: with the default **Monitor: All albums + Search on add**, Lidarr fetches the artist's complete metadata from its metadata server and immediately fires indexer searches for the *entire discography*. For a prolific artist (think jam bands with 100+ live releases) that's minutes of sustained CPU, network, and indexer traffic — inside Lidarr, after AudioSeerr's part is already done. If you see Lidarr working hard right after requests, that's what it's doing, and it's tunable in **Admin → Connections → Lidarr add behaviour**: monitor only the latest album, only future releases, or nothing (add unmonitored and grab things manually), and/or turn off search-on-add so Lidarr picks releases up on its own RSS/schedule instead of all at once. Everything else AudioSeerr does — status badges, in-library checks, dashboard summaries — is cached, single-flighted, and failure-backed-off so it stays background noise to Lidarr.

## API access

Log in as an admin and open **API Access** in the sidebar to generate keys. Keys are stored in `db.json` (not in `.env`) and can be regenerated or revoked at any time.

A key acts as an **admin service account** with no daily request limit — it can browse, request, and moderate. It deliberately **cannot** manage users or other keys, read or change connection settings, or download a backup: those require a logged-in admin session, so a leaked key cannot exfiltrate your Lidarr credentials, mint more keys, or repoint AudioSeerr at another server.

Send the key with every request as an `X-Api-Key` header (an `Authorization: Bearer <key>` header also works):

```bash
# Request an artist
curl -X POST "http://your-host:7575/api/requests" \
  -H "X-Api-Key: as_xxxxxxxx..." \
  -H "Content-Type: application/json" \
  -d '{"type":"artist","artistName":"Daft Punk"}'

# Request a specific album (added to Lidarr as the artist; album name is recorded)
curl -X POST "http://your-host:7575/api/requests" \
  -H "X-Api-Key: as_xxxxxxxx..." \
  -H "Content-Type: application/json" \
  -d '{"type":"album","artistName":"Daft Punk","albumName":"Discovery"}'
```

Key **management** endpoints (`/api/apikeys`) require a logged-in admin session — an API key cannot mint or list other keys.

### Selected endpoints

| Method & path                  | Auth          | Purpose                                            |
|--------------------------------|---------------|----------------------------------------------------|
| `GET /api/health`              | none          | Liveness + version (used by the Docker healthcheck) |
| `GET /api/search`              | session/key   | Search artists (Deezer + MusicBrainz) or albums (MusicBrainz) — `?q=`, `?type=artist\|album` |
| `POST /api/discover/mood`      | session/key   | Mood Discovery picks from `{ seeds, mood, count }` (Deezer-powered, keyless) |
| `GET /api/lidarr/in-library`   | session/key   | Is an artist already in Lidarr? (`?artistName=`)    |
| `GET /api/lidarr/search-artist`| session/key   | Lidarr artist lookup for the request picker         |
| `GET /api/lidarr/search-album` | session/key   | Lidarr album lookup for the request picker          |
| `GET /api/lidarr/status`       | session/key   | Lidarr connection state + version                   |
| `GET /api/lidarr/profiles`     | session/key   | Quality / metadata / root-folder config             |
| `GET /api/lidarr/queue`        | session/key   | Lidarr download queue (`?limit=`, 1–100)            |
| `DELETE /api/lidarr/queue/:id` | admin/key     | Remove a stuck grab (`?blocklist=1` to blocklist it) |
| `POST /api/lidarr/search`      | admin/key     | Trigger a Lidarr search by `lidarrId`               |
| `GET /api/requests`            | session/key   | All requests (admin/key) — `?search= ?status= ?type= ?limit=` (`status` also accepts `approved`/`pending`/`rejected`) |
| `GET /api/requests/stats`      | admin/key     | Request counters: `{ total, approved, pending, rejected, ok, problem, today }` |
| `GET /api/requests/mine`       | session/key   | The current user's own requests                     |
| `POST /api/requests`           | session/key   | Create a request                                    |
| `POST /api/requests/:id/approve`| admin/key    | Approve a pending/rejected request → sends to Lidarr |
| `POST /api/requests/:id/reject`| admin/key     | Reject a pending request (optional `{"reason":"…"}`) |
| `DELETE /api/requests/:id`     | session/key   | Delete a request (own request, or any as admin/key)  |
| `GET /api/summary`             | session/key   | One-call dashboard summary — **scoped to the caller** (admins/keys see the whole instance, a regular user sees only their own) |
| `GET /api/settings/approvals`  | admin/key     | Approval settings (`{ autoApproveAll }`)            |
| `PUT /api/settings/approvals`  | admin session | Toggle global auto-approve                          |
| `GET /api/discover/for-you`    | session/key   | Library-seeded recommendation rows (`?shuffle=1` for new seeds) |
| `GET /api/settings/lidarr-add` | admin/key     | Add behaviour (`{ monitor, searchOnAdd }`)          |
| `PUT /api/settings/lidarr-add` | admin session | Set monitor mode (`all/latest/future/none`) + search-on-add |
| `GET /api/settings/connections`| admin session | Effective Lidarr/Last.fm config (keys masked)       |
| `PUT /api/settings/connections`| admin session | Save Lidarr/Last.fm connection settings             |
| `POST /api/settings/lidarr/test`| admin session| Test a Lidarr URL/key without saving                |
| `GET /api/preferences`         | session/key*  | Current user's synced UI preferences                |
| `PUT /api/preferences`         | session       | Merge-update preferences (persisted)                |
| `GET /api/settings/notifications` | admin session | Notification targets (URLs masked)               |
| `POST /api/settings/notifications` | admin session | Add a target `{ type, url, label?, events? }`   |
| `DELETE /api/settings/notifications/:id` | admin session | Remove a target                          |
| `POST /api/settings/notifications/:id/test` | admin session | Send a sample notification          |
| `GET /api/settings/retention`  | admin/key     | Request-history retention (`{ keepDays, keepMax }`) |
| `PUT /api/settings/retention`  | admin session | Set retention (0 / blank = keep forever)            |
| `GET /api/backup`              | admin session | Download `db.json` (`?redact=0` for the raw file)   |
| `GET /api/requests/export.csv` | admin/key     | Request history as CSV (same filters as `/api/requests`) |
| `GET /api/discover/itunes-new` | session/key   | Apple "most recent" album feed (New & Upcoming)     |

\* API-key callers get default preferences (they have no personal UI session).

## Dashboard integration

AudioSeerr slots into a dashboard the same way the *arr services do. Read `/api/summary` with an API key.

> [!WARNING]
> An AudioSeerr API key is a **full-access admin service account**. Only inject it on the single endpoint your dashboard needs, and make sure that location is reachable only by your dashboard's backend. A blanket `location /audioseerr/ { proxy_set_header X-Api-Key … }` turns *every* admin route — user management included — into an unauthenticated API for anyone who can reach that path.

```nginx
# Scoped to one endpoint. The key is injected here, never exposed in the browser.
location = /audioseerr/summary {
    proxy_pass http://host.docker.internal:7575/api/summary;
    proxy_set_header X-Api-Key  as_xxxxxxxxxxxxxxxx;   # from Admin → API Access
    proxy_set_header Host       $host;
    allow 172.16.0.0/12;   # your dashboard's network only
    deny  all;
}
```

> **No URL base.** AudioSeerr serves its assets and API from the root (`/style.css`, `/api/…`), so it must be reachable at the root of a host or port — a sub-path proxy like `location /audioseerr/ { proxy_pass …/; }` will serve `index.html` and then 404 every asset. Give it its own subdomain or port, or use the iframe embed below.

`/api/summary` returns everything a tile needs in one call:

```jsonc
{
  "app": "AudioSeerr",
  "version": "2.10.0",
  "lidarr":   { "connected": true, "version": "2.x", "reason": null },
  "queue":    { "count": 3 },
  "scope": "all",          // "all" for admins/API keys, "mine" for a regular user
  // total = approved + pending + rejected;  approved = ok + problem
  // (ok = Lidarr accepted; problem = approved but Lidarr delivery failed;
  //  available = Lidarr actually has the music)
  "requests": { "total": 42, "approved": 39, "pending": 2, "rejected": 1, "ok": 37, "problem": 2, "available": 31, "today": 4 },
  "users": 5,              // admin/key only
  "apiKeys": 2,            // admin/key only
  "recent": [ /* most recent requests — each carries status AND a normalised
                 approvalStatus ('approved' | 'pending' | 'rejected'), so
                 dashboard tiles can badge them without special cases */ ]
}
```

Need just the counters (no live Lidarr round-trip)? `GET /api/requests/stats` returns the same `requests` object on its own — both are computed by the same counting rule, so a dashboard tile and the in-app Admin counters can never disagree. To list a specific bucket, filter the requests feed: `GET /api/requests?status=pending` (also `approved`, `rejected`).

### Iframe embed

```html
<iframe src="http://your-host:7575" style="width:100%;height:100%;border:0"></iframe>
```

## Passwords

- **Change your own:** click the 🔑 button by your name (sidebar, or top bar on mobile), confirm your current password, set a new one. `POST /api/auth/change-password` (JWT session only — not API keys).
- **Admin reset:** Users page → **Edit** the user → type a new password (leave blank to keep the existing one) → Save.
- **Sessions are revocable.** Changing a password signs out every *other* device (the tab that made the change gets a fresh token). Changing a user's role or resetting their password from the Users page revokes their existing sessions too, and deleting an account invalidates its tokens immediately — none of which used to happen, so a demoted admin kept admin access until their year-long token expired.

## Security

AudioSeerr's container is hardened out of the box:

- **Minimal pinned base** — multi-stage build on `node:20-alpine3.20` (pinned, not `:latest`), runtime image carries only production `node_modules`. Scan with `docker scout cves audioseerr:2.10.0` or `trivy image audioseerr:2.10.0`.
- **Least privilege** — runs as the non-root `node` user (uid/gid 1000); `cap_drop: ALL`; `no-new-privileges`.
- **Filesystem & network** — read-only root filesystem with a `tmpfs` for `/tmp`; only `./data` is writable, and `db.json` is written atomically (temp file + rename) so a crash mid-write can't corrupt it. Runs on its own bridge network.
- **Secrets** — nothing baked into the image (`.env` is excluded via `.dockerignore`); `*_FILE` variants support Docker secrets / vaults; production refuses insecure default secrets. Connection settings saved from the app live in `db.json` (same sensitivity as `.env` — keep `./data` private); they are readable/writable only from a logged-in **admin session** — external API keys can neither read nor change them, and saved keys are never echoed back to the browser (masked tail only).
- **Containment** — `mem_limit`, `cpus`, and `pids_limit` cap resources; JSON log rotation prevents unbounded disk growth; `init: true` gives a real PID 1 for correct signal handling.
- **Sessions** — tokens are validated against the database on every request (not just verified), so role changes, password changes and account deletions take effect immediately. `SESSION_DAYS` shortens the window; `POST /api/auth/refresh` re-checks the account rather than re-signing the caller's own claims.
- **Data durability** — `db.json` is written atomically with `fsync`, a `.bak` generation is kept, and a corrupt or unreadable database is reported as a 503 instead of being silently replaced by an empty one.
- **Outbound requests** — credentials (`X-Api-Key`, `Authorization`, `Cookie`) are stripped on cross-origin redirects, responses are size-capped, and a non-JSON reply to an API call is treated as an error rather than accepted.

**What the browser talks to.** All music-catalogue calls (Deezer, Last.fm, iTunes, MusicBrainz, Cover Art Archive) go through the server, so your API keys never reach the browser. The page itself does load two third-party resources directly: **Google Fonts** (`fonts.googleapis.com`, `fonts.gstatic.com`) for the Inter typeface, and **ui-avatars.com** for the generated placeholder used when an artist has no artwork. Cover art is also loaded straight from the provider's CDN. If you want a fully self-contained instance, self-host the font and replace the `fallback()` helper in `public/app.js` with a local or inline SVG.

**Your responsibility:** keep the Docker engine updated, and don't expose AudioSeerr directly to the internet — front it with a reverse proxy (TLS + auth). The app intentionally allows iframe embedding (`frame-ancestors *`); if you don't embed it, tighten that at your proxy.

## Tech stack

- **Backend:** Node.js 20 · Express · JWT auth · bcrypt · helmet · express-rate-limit
- **Frontend:** vanilla JS / HTML / CSS (no build step), served from `public/`
- **Storage:** flat-file `db.json` (atomic writes)
- **External:** Lidarr API · MusicBrainz · Last.fm / Deezer / iTunes

## Contributing

[Issues](https://github.com/jordydabs/audioseerr/issues) and pull requests are welcome. For larger changes, please open an issue first to discuss what you'd like to change.

Found a security problem? Please report it privately — see [SECURITY.md](SECURITY.md) — rather than opening a public issue.

### Cutting a release (maintainers)

1. Run `npm version X.Y.Z --no-git-tag-version` (bumps `package.json` and the lockfile), update the version in `docker-compose.yml` and the README examples, add a dated entry to `CHANGELOG.md`, and write `docs/releases/vX.Y.Z.md` — its first line (`# Title`) becomes the release title.
2. Merge to `main`, then tag that commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The **Release** workflow publishes the GitHub release from that notes file. (It can also be run by hand from the Actions tab.)

## License

Released under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, change and share
AudioSeerr for any noncommercial purpose (personal use, hobby projects, research, charities, schools
and similar), but you may not sell it or use it commercially.
