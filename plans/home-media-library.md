# Plan: Self-Hosted Home Media Library (`b2-indexer`)

**Status:** Final — home-server baseline
**Date:** 2026-11-06
**Author:** Maintainers
**Scope:** Architecture, decisions, duplicate handling, and phased delivery. No
application code in this document.

> **Revision note.** This replaces `aws-scale.md`. The project is finalized as a
> **home-server-first** system: this home server runs indexing and serves the
> app; B2 stays the system of record for bytes; local SQLite is the catalog.
> There is no cloud control plane in scope. AWS is reduced to a short deferred
> escape hatch (Appendix A) and is not part of the delivery plan.

**Contents**

0. [TL;DR and finalized decisions](#0-tldr-and-finalized-decisions)
1. [Goals, constraints, non-goals](#1-goals-constraints-non-goals)
2. [Where the codebase is today](#2-where-the-codebase-is-today)
3. [Architecture](#3-architecture)
4. [Duplicate detection and purging](#4-duplicate-detection-and-purging)
5. [Data model](#5-data-model)
6. [Search](#6-search-how-fts5-answers-gopro)
7. [Scaling thresholds](#7-scaling-thresholds)
8. [Operations](#8-operations)
9. [Security and privacy](#9-security-and-privacy)
10. [Implementation plan](#10-implementation-plan)
11. [Risks](#11-risks)
- [Appendix A — Deferred cloud path](#appendix-a--deferred-cloud-path-not-in-scope)
- [Appendix B — Parquet + DuckDB](#appendix-b--parquet--duckdb-analytics-optional-local)
- [Appendix C — Cost model](#appendix-c--cost-model)
- [Appendix D — Glossary](#appendix-d--glossary)
- [Appendix E — Sources](#appendix-e--sources-verify-before-committing)

---

## 0. TL;DR and finalized decisions

Build a self-hosted Google Photos for a B2 bucket you already own:

- **B2** — originals and any derivatives. Never duplicated into another cloud.
- **Home server** — indexer, `data/library.db` (SQLite + FTS5), Node API.
- **Caddy** — HTTPS, SPA, reverse proxy, basic auth. Replaces CloudFront/API
  Gateway.
- **Access** — LAN (`<lan-ip>`) and Tailscale (`<overlay-ip>`).
- **Duplicates** — exact SHA-1 detection is always on; perceptual near-dupes are
  opt-in; purging is report → approve → hide → retention → delete, never
  automatic.
- **AWS** — not used. Revisit only if a §7 trigger is crossed.

### Finalized decisions

| Decision | Final choice | Rationale |
|---|---|---|
| Deployment target | This home server only | Already always-on, has CPU for `sharp`/`ffmpeg`, no cloud bill |
| Bytes of record | Backblaze B2, private bucket | Terabytes stay at storage pricing, not compute/egress |
| Catalog | `data/library.db`, SQLite WAL + FTS5 | Rebuildable, one file, sub-ms reads |
| Serving | Caddy + Node API; browser ↔ B2 direct for originals | Home uplink never carries full-resolution video |
| Ingest | Polling reconciliation (15–60 min) | No public webhook endpoint behind double NAT |
| Access model | LAN + Tailscale, Caddy `basic_auth`, no port forward | Single-user personal library |
| Derivatives | Local `dist/thumbs/` only for v1 | Simplest; mirror to B2 only if disk pressure appears |
| Search | FTS5 (`unicode61`) on name/album/tags + EXIF columns | Good enough without ML; measured single-digit ms |
| Dedupe — exact | Always on, `content_sha1` from B2 listing | Free, authoritative, no extra reads |
| Dedupe — near | Opt-in `phash` (64-bit), Hamming threshold | Catches re-encodes/resizes without false confidence |
| Purge policy | Manual approval + `hide` + retention + `delete` | Originals are irreplaceable; no silent deletion |
| Transcoding | None by default; download fallback | Full-library transcoding is a cost sink |
| Static HTML | Export fallback only; SPA is primary | Current generators remain usable but not the UI |
| Scale target | 1M objects comfortable; 3M on SQLite; shard beyond | 1M rows ≈ 90 MB structured / 120 MB FTS |
| Backup | Daily `sqlite3 .backup`; Litestream optional | Online-safe; catalog is rebuildable anyway |

**Sizing assumption:** 1M objects / 10 TB for planning, scaling to 10M with
sharding. The real object count is confirmed in Phase 0; nothing in the design
depends on it.

---

## 1. Goals, constraints, non-goals

### Goals

1. Browse and search a B2 bucket containing images, video, and audio.
2. Cheap at rest: storage rates, not compute or egress rates.
3. Cheap when idle: no managed database, cluster, or always-billed service.
4. Scalable from 10k to ~3M objects on one box without re-architecting.
5. Own the data: media in B2; metadata in a portable SQLite/Parquet file.
6. Good UX: timeline, albums, date filters, keyword search, thumbnails, video,
   downloads.
7. Secure by default: private bucket, least-privilege keys, LAN/Tailscale only.
8. Find and reclaim duplicate bytes safely.
9. Undemanding operations: one box, a few systemd timers, one Caddy site.

### Constraints

- B2 is the system of record for bytes. Do not duplicate originals into S3 or
  onto the home disk.
- Home server: single machine (a modest SSD), behind
  double NAT, LAN `<lan-ip>`, Tailscale `<overlay-ip>`.
- Existing repo is CommonJS Node.js with a CLI pipeline and `dist/` output.
  Node >= 20.9.0.
- `ffmpeg` is available; `sharp` is already a dependency.
- Some video may not play natively (HEVC/MOV); handle gracefully, do not assume
  transcoding.
- Local disk is finite: 1 TB shared with other services.

### Non-goals (v1)

- Multi-tenant SaaS, real-time collaboration, or family multi-user accounts.
- Automatic ML face clustering / semantic search (hook only, deferred).
- Full-library video transcoding (opt-in on-demand proxies only).
- Perfect real-time consistency (minutes-to-hours is fine).
- High availability (server down = gallery down; bytes remain safe in B2).
- Automatic deletion of anything without explicit approval.

---

## 2. Where the codebase is today

Current pipeline (`index.js` → `thumbs.js` → `download_links.js` →
`generate_albums.js` → `generate_site*.js`) is a good prototype with these
scaling limits:

| Area | Current behavior | Problem at scale |
|---|---|---|
| Listing | `b2.listFileNames` full scan into `dist/index.jsonl` | Full rescan every run; no watermark or diff |
| Thumbnails | Downloads each original, resizes locally | Single machine, concurrency 5; no incremental tracking |
| Thumbnail naming | Flattens `/` to `_` | Cross-folder collisions |
| Downloads | Pre-generates a token URL for every file into one JSON | Tokens expire; file grows unbounded; leaks capability |
| Albums | First path segment only | No capture-date albums, tags, or search |
| Site | Pre-rendered static HTML, 50/page | No search; page count grows linearly |
| Metadata | Name, size, contentType, sha1, upload time | No EXIF, GPS, dimensions, duration, dedupe hash |
| Auth | None | Public static output |
| Idempotency | File existence check | No durable per-object state; renames/deletes not handled |
| Duplicates | None | Identical bytes indexed and paid for repeatedly |

Keep the good parts: streaming JSONL, atomic writes, `sharp`/`ffmpeg` logic,
B2 native download-by-id, `EXCLUDE_PATHS`.

---

## 3. Architecture

### 3.1 Design principles

1. **Three planes on one box.**
   - **Media plane** (huge): B2 originals + optional derivatives. Never copied
     locally at full size.
   - **Metadata plane** (small): `library.db` + `dist/thumbs/`.
   - **Control plane** (tiny): systemd timers, Node API, Caddy.
2. **Download once, derive once.** Each original is read once for EXIF/ffprobe,
   hashes, and thumbnails. Serving never re-reads originals.
3. **B2 is truth; SQLite is a cache.** The catalog is rebuildable by re-listing
   (free) and re-deriving.
4. **The app never lists the bucket.** It queries indexed rows only.
5. **Everything idempotent.** Upsert by a stable key; re-runs are safe.
6. **One writer.** The indexer writes; the API reads. WAL for concurrent reads.
7. **Destructive actions are explicit.** Dedupe scans are safe; purge requires
   approval and a retention window.
8. **Two-tier realism.** Start with polling + SQLite. Add queues, webhooks, or
   the cloud only when a measured threshold is crossed.

### 3.2 Target diagram

```
 ┌──────────────────────── Backblaze B2 (private) ────────────────────────┐
 │  media/…                 originals (images / video / audio)            │
 │  _derived/thumbs/…       optional thumbnails (deferred mirror)         │
 │  _quarantine/…           hidden duplicates awaiting hard delete        │
 └───────────┬──────────────────────────────────────────┬─────────────────┘
             │ b2_list_file_names (free, polled)        │ S3-compatible GET
             │ b2_download_file_by_id (once per item)   │ / presigned URL
             ▼                                          │
 ┌──────────────────── Home server (this box) ──────────┼─────────────────┐
 │  systemd timers                                       │                 │
 │    index.js    list → diff vs library.db → enqueue    │                 │
 │    derive.js   download → sharp/ffprobe → hashes      │                 │
 │                     → thumbnail → upsert row          │                 │
 │    dedupe.js   scan → report → approve → hide/purge   │                 │
 │    compact.js  FTS optimize, tombstone prune, counts  │                 │
 │                                                       │                 │
 │  library.db  (SQLite WAL)                             │                 │
 │    items / duplicate_groups / duplicate_members       │                 │
 │    albums / tags / items_fts / meta                   │                 │
 │                                                       │                 │
 │  server.js   Node API (better-sqlite3)                │                 │
 │    /api/timeline /api/search /api/albums              │                 │
 │    /api/items/:id/stream → 302 presigned B2 URL ──────┘                 │
 │                                                       │                 │
 │  Caddy :443  photos.internal                        │                 │
 │    /      → file_server  dist/ (SPA + thumbs/)        │                 │
 │    /api/* → reverse_proxy localhost:8090              │                 │
 └───────────┬───────────────────────────────────────────┘                 │
             │ LAN <lan-ip>  /  Tailscale <overlay-ip>                  │
             ▼                                                               │
        Browser (desktop + phone) ──── fetch thumbnails from Caddy           │
                                    └ fetch originals directly from B2 ─────┘
```

### 3.3 B2 layout and keys

```
<bucket>/
  media/2024/2024-07-…            # originals (user uploads)
  _derived/thumbs/…               # optional mirror; regenerable
  _derived/previews/…             # optional larger previews
  _derived/posters/…              # video poster frames
  _quarantine/…                   # hidden duplicates during retention
  _index/…                        # exports/manifests, never indexed
```

- Reserved prefixes (`_derived/`, `_quarantine/`, `_index/`) are **excluded**
  from the indexer and from any event rule. `EXCLUDE_PATHS` stays, but these
  reserved prefixes are non-configurable.
- Keys, least privilege:
  - `indexer-ro`: list + download (Class B/C), no write.
  - `app-ro`: download authorization / presign only.
  - `purge-rw`: separate key with `deleteFiles`/`writeFiles`, used only by the
    purge job. Never loaded by the API or the indexer.
- Private bucket. No public ACLs; presigned URLs only.
- Thumbnails are regenerable, so local-only storage is valid. At 10M items the
  set is ~600 GB, which will not fit beside everything else on the local SSD;
  mirroring is a disk-budget decision, not a default.

### 3.4 Ingestion: polling reconciliation

B2 object-change webhooks require support enablement and a reachable HTTPS
endpoint. This box is behind double NAT, so polling is the chosen design:

```
every 15–60 min (nightly full re-list for a cold library):
  b2_list_file_names (paginate; free)
    → compare fileId + contentSha1 + size against items
    → new/changed  → status='listed', enqueue derive
    → missing      → status='deleted', deleted_at=now (tombstone)
    → unchanged    → nothing
```

Properties:

- No webhook, public endpoint, SQS, or signature verification.
- The diff is idempotent by construction.
- A full re-list is both the routine job and the disaster-recovery path.
- Store the continuation token and resume if a run exceeds its window.
- **Never** write derived artifacts into a prefix the indexer scans. That is the
  infinite-loop trap: upload thumb → list sees a new object → derive again.

Webhook ingest is deferred. If ever added, expose it through Tailscale Funnel or
Cloudflare Tunnel (never a raw port forward), verify HMAC, and keep polling as
the mandatory safety net.

### 3.5 Indexing and derivation

Two passes; only the second downloads.

**Pass 1 — inventory (free).** `b2_list_file_names` returns `fileName`,
`contentLength`, `contentSha1`, `contentType`, `fileId`, `uploadTimestamp`.
Upsert immediately:

```sql
INSERT INTO items (object_key, file_id, content_sha1, size_bytes, content_type,
                   uploaded_at, status)
VALUES (?, ?, ?, ?, ?, ?, 'listed')
ON CONFLICT(object_key) DO UPDATE SET
  file_id = excluded.file_id,
  content_sha1 = excluded.content_sha1,
  size_bytes = excluded.size_bytes,
  status = CASE WHEN items.content_sha1 = excluded.content_sha1
                THEN items.status ELSE 'listed' END;
```

**Pass 2 — derive (downloads only new/changed).**

```
b2_download_file_by_id (stream)
  → sharp metadata/EXIF  or  ffprobe       (needs the bytes)
  → thumbnail → dist/thumbs/xxx.tmp → rename  (atomic)
  → phash (optional, images)               (for near-dupe detection)
  → UPDATE items SET taken_at, width, height, camera_make, camera_model,
                     gps_lat, gps_lon, duration_ms, thumb_key, phash,
                     status='derived', indexed_at=now
```

- Original bytes are discarded after processing; nothing is uploaded back.
- `status` (`listed` | `derived` | `failed` | `deleted` | `quarantined`) makes
  runs resumable.
- Thumbnail names must be collision-free. Replace `thumbKey()` path flattening
  with `sha1(object_key)` or a normalized path hash.
- Concurrency via `p-limit`; `THUMBNAIL_CONCURRENCY` stays. Prioritize
  newest-first so the timeline is usable early.
- Cap file size for in-process derivation; put oversized videos on a retry list.

**One-time cost:** the first derivation reads the whole library once. At
100 MB/s, 10 TB is roughly 28 hours of sustained download. Throttle by window
(e.g. overnight) and let `status` resume. B2 egress is free within the 3×
monthly allowance.

### 3.6 Local catalog (SQLite)

One file: `data/library.db`. SQLite in WAL mode, `busy_timeout` set, single
writer (the indexer). Full schema in §5.

- Size scales with object count, not media size: ~0.5–1.5 KB/row.
- `items` holds structured columns; `items_fts` is the inverted text index.
- `meta` holds `schema_version`, last list token, last run timestamps.
- Rebuild into `library.db.tmp` then `rename()` for an atomic swap, matching the
  existing `writeJsonAtomic` pattern.

### 3.7 Serving: Caddy + Node API

Caddy already runs on this host with internal TLS and split-DNS hostnames. Add
one site block:

```caddyfile
photos.internal {
    root * /srv/b2-indexer/dist

    handle /api/* {
        reverse_proxy localhost:8090
    }
    handle {
        file_server
        encode gzip
    }

    basic_auth {
        user $2a$14$...
    }

    tls internal
}
```

- dnsmasq entry in `the local DNS configuration`, following the existing
  convention (map to `<overlay-ip>` for Tailscale; LAN clients can use
  `<lan-ip>`).
- The API is one Node process with `better-sqlite3` (synchronous, one query per
  request, no pool). Read endpoints:

```
GET /api/timeline?year=&cursor=
GET /api/search?q=&from=&to=&album=&type=&cursor=
GET /api/albums
GET /api/duplicates?kind=exact&status=candidate
GET /api/items/:id/stream   -> 302 to short-TTL B2 presigned URL
```

- Keyset pagination on `(taken_at DESC, id)`, never `OFFSET` at depth.
- Static SPA and thumbnails come from `file_server`; the API returns metadata
  and a signed media URL only.
- Purge mutations are **not** exposed through the public API in v1; they run as
  CLI jobs under the `purge-rw` key.

### 3.8 Media delivery

- **Thumbnails**: local disk via Caddy. Instant on LAN, zero egress.
- **Originals/video**: `302` to a B2 presigned URL (5–15 min TTL, per request).
  The browser pulls bytes directly from B2; the home uplink is not in the path.
  - Consequence: LAN playback still traverses the WAN to B2. That is the price
    of not storing 100 TB locally. B2 supports range requests, so seeking works.
  - Do **not** proxy media through Node/Caddy: it saturates the uplink and ties
    up the process.
- Unsupported codecs: detect with `ffprobe`; offer download fallback; optionally
  generate an H.264 proxy on demand into `_derived/`. Never transcode the whole
  library.

### 3.9 Web app

- SPA (React/Vue/Svelte) in `dist/`, served by Caddy.
- Views: timeline (infinite scroll, grouped by month), albums, search, item
  detail/lightbox, video player, download, duplicate review.
- Thumbnails: lazy-loaded, `srcset`, `loading="lazy"`, content-visibility for
  long timelines.
- Search: debounce 250–300 ms, cancel in-flight requests, show skeletons.
- Offline/PWA optional.

### 3.10 Request flows

**Upload → visible**

```
rclone uploads to B2 media/…
  → next polling run sees a new fileId
  → status='listed' → derive: download, EXIF/ffprobe, hashes, thumbnail
  → upsert row, status='derived'
  → next UI query sees it (no rebuild needed for row changes)
```

**Browse/search**

```
browser → Caddy (auth) → GET /api/timeline or /api/search
  → server.js → SQLite index lookup → JSON (metadata + item ids)
  → browser requests thumbnails → Caddy file_server (local disk)
  → open item → GET /api/items/:id/stream → 302 → B2 (range-capable)
```

**Delete/rename**

```
B2 object disappears (or fileId changes)
  → diff marks status='deleted', deleted_at=now
  → queries filter deleted_at IS NULL
  → compaction prunes tombstones per retention policy
```

**Duplicate found**

```
dedupe scan (sha1 group, optional phash cluster)
  → duplicate_groups/members (status='candidate', no B2 writes)
  → report reviewed, group approved
  → duplicate hidden in B2 (reversible), thumbs/DB marked quarantined
  → after retention, version deleted; bytes reclaimed; audit row written
```

---

## 4. Duplicate detection and purging

Duplicates are the main way a personal library silently wastes money: the same
bytes are stored (and thumbnailed, and indexed) under several names. The design
has two detection tiers and a deliberately slow destructive path.

### 4.1 Duplicate classes

| Class | Detection | Confidence | Default action |
|---|---|---|---|
| Exact copy | Equal `content_sha1` + equal size | Certain | Report; purge allowed after approval |
| Same-name old version | `b2_list_file_versions` | Certain | Report; optional version cleanup |
| Near-duplicate | 64-bit `phash` Hamming distance ≤ threshold | Heuristic | Review only; never auto-purge |
| Zero-byte / placeholder | `size_bytes = 0` | Certain | Flag separately; usually keep or ignore |
| Same filename, different bytes | Equal `object_key` (impossible after unique constraint) | n/a | Treated as a version, not a duplicate |

Exact duplicates are free to find: B2 already returns `contentSha1`. Near-dupes
require one-time `phash` computation during derivation.

### 4.2 Exact duplicate scan

```sql
-- Groups worth reviewing, largest reclaimable first.
SELECT content_sha1,
       COUNT(*)              AS copies,
       SUM(size_bytes)       AS total_bytes,
       MIN(uploaded_at)      AS first_uploaded
FROM items
WHERE deleted_at IS NULL
  AND status NOT IN ('deleted', 'quarantined')
  AND content_sha1 IS NOT NULL
  AND size_bytes > 0
GROUP BY content_sha1
HAVING COUNT(*) > 1
ORDER BY total_bytes DESC;
```

Members of a group, deterministic order:

```sql
SELECT id, item_id, object_key, size_bytes, uploaded_at, album, width, height
FROM items
WHERE content_sha1 = ? AND deleted_at IS NULL
ORDER BY uploaded_at ASC, id ASC;
```

Notes:

- Reclaimable bytes = `total_bytes - size_bytes(survivor)`.
- `content_sha1` is per-file content, so equal hashes mean byte-identical files.
- B2's `contentSha1` is not a cryptographic proof against deliberate collision,
  but for personal media it is authoritative enough. If paranoia is required,
  spot-check with a streamed SHA-1 before hiding.
- Dedupe across **live object names** is the default. Deleting historical
  versions is a separate, opt-in job using `b2_list_file_versions`; old versions
  do not appear in `list_file_names`.

### 4.3 Near-duplicate detection (opt-in)

Near-dupes are visually similar but not byte-identical: re-encodes, resized
exports, messaging-app copies, screenshots of screenshots.

**Hash.** During derivation, compute a 64-bit difference hash (`dHash`) with
`sharp`: decode → grayscale → resize to 9×8 → compare adjacent pixels. Store as
16 hex characters in `items.phash`. `dHash` is cheap and robust to scale and
minor color changes; `pHash` (DCT) is an alternative if rotation/cropping noise
matters.

**Comparison.** Hamming distance ≤ 8 (default, configurable) marks a candidate.
Distance 0 is effectively an exact visual match; this is still only a candidate,
never an automatic purge.

**Scale.** Pairwise comparison is O(n²) and unusable at millions of items. Use
blocking:

1. Never compare across `media_type`.
2. Only compare items whose `size_bytes` ratio is within 0.5–2.0.
3. Only compare within a time window (e.g. `taken_at` ± 3 days) unless the user
   explicitly asks for a global scan.
4. Within a block, use banded LSH: split the 64-bit hash into four 16-bit bands
   and index each band; candidate pairs share at least one band. Verify the full
   Hamming distance before recording a pair.

Near-dupe scans are CPU-light once hashes exist but can still produce large
review lists. Cap the report (`DUPE_NEAR_MAX_PAIRS`, default 5000) and rank by
distance, then by reclaimable bytes.

**Do not** delete near-dupes automatically. Two visually similar photos can be
different moments (burst shots, brackets, edits). They are review material.

### 4.4 Choosing the survivor

For every group, the survivor is chosen deterministically and shown in the
report:

1. **Canonical prefix wins** — `media/` beats `imports/`, `duplicates/`,
   `whatsapp/`, etc. Configurable preference list.
2. **Highest resolution wins** for images/video (more pixels).
3. **Earliest upload wins** — preserves the original import.
4. **Shortest object key**, then lexicographic order, as tie-breakers.
5. A tombstoned, failed, or quarantined row can never be the survivor.

The ranking is a recommendation. The approval step may override it per group.

### 4.5 Duplicate state model

The DB records every decision so re-runs are idempotent and nothing is deleted
twice or silently.

```sql
CREATE TABLE duplicate_groups (
  id               INTEGER PRIMARY KEY,
  kind             TEXT NOT NULL,              -- exact | near
  group_key        TEXT NOT NULL,              -- sha1 or cluster id
  member_count     INTEGER NOT NULL,
  reclaimable_bytes INTEGER NOT NULL,
  survivor_item_id TEXT,
  status           TEXT NOT NULL DEFAULT 'candidate',
                   -- candidate | approved | quarantined | purged | dismissed
  created_at       INTEGER,
  updated_at       INTEGER,
  UNIQUE (kind, group_key)
);

CREATE TABLE duplicate_members (
  group_id      INTEGER NOT NULL REFERENCES duplicate_groups(id),
  item_id       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'duplicate',  -- survivor | duplicate
  match_distance INTEGER,                            -- NULL for exact; Hamming for near
  action        TEXT NOT NULL DEFAULT 'keep',        -- keep | quarantine | purge
  acted_at      INTEGER,
  PRIMARY KEY (group_id, item_id)
);

CREATE INDEX duplicate_groups_status ON duplicate_groups(status, reclaimable_bytes DESC);
```

Item-level additions:

```sql
ALTER TABLE items ADD COLUMN phash TEXT;
ALTER TABLE items ADD COLUMN duplicate_of TEXT;   -- survivor item_id, if known
ALTER TABLE items ADD COLUMN quarantined_at INTEGER;
ALTER TABLE items ADD COLUMN purged_at INTEGER;
```

State machine:

```
candidate ──approve──► approved ──quarantine──► quarantined ──retention──► purged
    │                      │                          │
    └──dismiss────────────► dismissed                 └──restore (unhide)
```

### 4.6 Purge workflow

The destructive path is intentionally multi-step and observable.

**Step 1 — scan (no B2 writes).**

- Build/refresh exact groups from `content_sha1`.
- If `--near`, refresh near-dupe groups from `phash`.
- Write only `duplicate_groups` / `duplicate_members`.
- Re-running the scan preserves existing approvals for unchanged groups.

**Step 2 — report.**

- Emit `data/duplicate-report.json` plus a human-readable Markdown summary.
- Sort by reclaimable bytes. Each group lists survivor, members, reasons,
  distances, and total space reclaimed.
- Always prints a dry-run total; deletes nothing.

**Step 3 — approve.**

- `--group <id>` approves one group; `--all-exact` approves all exact groups
  above a size threshold; near-dupes require per-group approval.
- Approval refuses if the survivor is missing, tombstoned, or failed.
- Records `status='approved'`, `updated_at`.

**Step 4 — quarantine (reversible).**

- Re-verify each duplicate against the live B2 listing (`fileId`, `size`,
  `contentSha1`) immediately before mutating.
- Soft-delete with `b2_hide_file` (the bytes remain recoverable). Do not copy.
- Delete the local thumbnail/preview/poster for the hidden item.
- Set `items.status='quarantined'`, `quarantined_at=now`; members
  `action='quarantine'`.
- Append every action to `data/purge-log.jsonl`.
- A hidden object is still billed; retention is for safety, not savings.

**Step 5 — purge (irreversible).**

- Only for `quarantined` members older than the retention window (default 30
  days) and never for a survivor.
- Hard-delete the specific version with `b2_delete_file_version` (needs
  `fileId` + `fileName` from `b2_list_file_versions`). `b2_hide_file` adds a
  zero-byte hide marker, so remove the hidden version **and** its marker; the
  original version is what actually frees storage.
- Mark `items.status='deleted'`, `purged_at=now`; group `status='purged'`.
- Remove FTS entries (or rebuild after the batch) and update album counts.
- Record reclaimed bytes in `data/purge-log.jsonl` and the report.

**Step 6 — verify.**

- Re-list affected prefixes; assert exactly one live copy per purged group.
- Assert survivor still downloads (HTTP 200 / expected size).
- Assert no `_derived/`, `_quarantine/`, or `_index/` object was touched.
- Print before/after object count and DB row count.

### 4.7 B2 mechanics and permissions

| Operation | API | Key capability |
|---|---|---|
| Find duplicates | `b2_list_file_names` | `listFiles` |
| Detect old versions | `b2_list_file_versions` | `listFiles` |
| Re-verify bytes | `b2_download_file_by_id` | `readFiles` |
| Soft-delete | `b2_hide_file` | `writeFiles` |
| Hard-delete | `b2_delete_file_version` | `deleteFiles` |
| Restore hidden | `b2_copy_file` of the underlying version to a live name | `readFiles` + `writeFiles` |

Rules:

- The purge key is separate from the indexer and app keys. It is loaded only by
  `dedupe.js` when `--apply` is passed.
- B2 deletes are per **version**. `delete_file_version` permanently removes that
  version; the bucket's lifecycle rules and versioning settings determine
  whether hidden data is later cleaned up automatically.
- `b2_hide_file` creates a zero-byte hide marker rather than removing bytes.
  Restoring means copying the underlying version back to a live name; purging
  means deleting both that version and the marker.
- Never call `delete_file_version` with a guessed fileId. Always resolve the
  version through a fresh listing.
- A bucket lifecycle rule scoped to `_quarantine/` may be used as a safety net,
  but the CLI must not rely on it to be correct.

### 4.8 Safety rails

These are mandatory in the implementation, not suggestions:

- **Dry-run by default.** Every mutating command requires `--apply`.
- **Explicit scope.** `--prefix <path>` allowlist; refuse if the prefix would
  match `_derived/`, `_quarantine/`, or `_index/`.
- **Freshness check.** Refuse to purge if the last successful index run is older
  than `DUPE_MAX_INDEX_AGE` (default 24 h).
- **Batch cap.** `--max <n>` (default 500) hides/deletes per run; re-run to
  continue.
- **Survivor protection.** The purge job asserts the survivor exists and is not
  in the action set before every mutation.
- **Exact-match only for auto-generated plans.** Near-dupes are never included
  in `--all-exact`.
- **Manifest re-check.** Hiding requires a matching `contentSha1` and size from a
  live listing obtained in the same run.
- **Audit log.** Append-only `data/purge-log.jsonl` (timestamp, group, item,
  action, fileId, object key, bytes, operator, result).
- **No API mutation.** The web app can review and approve; the CLI performs the
  hide/delete.
- **Retention.** `DUPE_QUARANTINE_DAYS` (default 30) must elapse before hard
  delete.
- **Backup before first apply.** Run `sqlite3 .backup` before the first purge
  batch.

### 4.9 Derivatives and catalog cleanup

When an item is quarantined or purged:

1. Delete local derivative files (`thumb_key`, `preview_key`, `poster_key`).
2. If derivatives are ever mirrored to B2, delete the `_derived/` versions too.
3. Remove or tombstone the `items` row; keep `content_sha1` and object key in the
   audit log so the decision is explainable.
4. Remove FTS entries incrementally or rebuild FTS after the batch.
5. Recompute `albums.item_count` and reselect covers if the removed item was a
   cover.
6. Leave `duplicate_groups`/`duplicate_members` in place as history; pruning
   them is part of `compact.js`.

### 4.10 Commands and outputs

```bash
npm run dedupe:scan        -- --exact               # build exact groups
npm run dedupe:scan        -- --exact --near        # add phash clusters
npm run dedupe:report                               # JSON + Markdown, dry run
npm run dedupe:approve     -- --group 12            # or --all-exact --min-bytes 1000000
npm run dedupe:quarantine  -- --apply --max 500     # hide, reversible
npm run dedupe:purge       -- --apply --older-than 30d
npm run dedupe:verify                               # re-list + integrity checks
```

Outputs:

```
data/duplicate-report.json     # machine-readable groups
data/duplicate-report.md       # review summary
data/purge-log.jsonl           # append-only audit trail
```

### 4.11 What not to do

- Do not purge by filename or size alone.
- Do not purge a group whose survivor is a near-dupe candidate only.
- Do not delete an object without resolving its version through a fresh listing.
- Do not bulk-delete across the whole bucket in one run; cap and review.
- Do not treat hidden objects as already reclaimed; storage is freed only when
  the version is deleted.
- Do not expose purge endpoints on the web API.
- Do not delete the last live copy of any `content_sha1`.

---

## 5. Data model

One row per current object. Stable keys matter.

### 5.1 `items`

```sql
CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  item_id       TEXT UNIQUE NOT NULL,   -- sha1(bucket + ':' + file_id)
  bucket        TEXT NOT NULL,
  object_key    TEXT UNIQUE NOT NULL,   -- full B2 object name
  file_id       TEXT NOT NULL,          -- B2 fileId (version-unique)
  content_sha1  TEXT,                   -- exact dedupe key
  content_type  TEXT,
  size_bytes    INTEGER,
  media_type    TEXT NOT NULL,          -- image | video | audio | other
  uploaded_at   INTEGER,                -- unix seconds
  taken_at      INTEGER,                -- EXIF/video/ID3, fallback uploaded_at
  taken_at_source TEXT,                 -- exif | video | id3 | filename | upload
  album         TEXT,                   -- first path segment
  path_segments TEXT,                   -- JSON array for folder browsing
  width         INTEGER,
  height        INTEGER,
  duration_ms   INTEGER,
  camera_make   TEXT,
  camera_model  TEXT,
  lens          TEXT,
  iso           REAL,
  f_number      REAL,
  exposure_time REAL,
  focal_length  REAL,
  gps_lat       REAL,
  gps_lon       REAL,
  orientation   INTEGER,
  thumb_key     TEXT,                   -- relative path under dist/thumbs/
  preview_key   TEXT,
  poster_key    TEXT,
  phash         TEXT,                   -- optional 64-bit perceptual hash (hex)
  duplicate_of  TEXT,                   -- survivor item_id, if known
  status        TEXT NOT NULL DEFAULT 'listed',
                -- listed | derived | failed | deleted | quarantined
  indexed_at    INTEGER,
  updated_at    INTEGER,
  deleted_at    INTEGER,
  quarantined_at INTEGER,
  purged_at     INTEGER
);

CREATE INDEX items_timeline ON items(taken_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX items_album ON items(album, taken_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX items_type ON items(media_type, taken_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX items_camera ON items(camera_make, camera_model);
CREATE INDEX items_sha1 ON items(content_sha1);
CREATE INDEX items_phash ON items(phash) WHERE phash IS NOT NULL;
```

### 5.2 `items_fts` (external-content FTS5)

```sql
CREATE VIRTUAL TABLE items_fts USING fts5(
  object_key, album, tags, ocr_text, transcript,
  content='items', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
```

- `content='items'` avoids duplicating text; the FTS table is only the index.
- Because `items` does not carry `tags`/`ocr_text` in the sketch above, either
  add those columns to `items` or use a separate `item_text` table joined to the
  index. Pick one and keep it consistent.
- Keep in sync with triggers for incremental changes, or run a `'rebuild'` after
  each batch (simple and fast enough for batch indexing).
- Run `INSERT INTO items_fts(items_fts) VALUES('optimize')` after large batches.
- `unicode61` is exact-token; add `porter` for stemming, or `trigram` if
  substring/typo search is required (larger index).

### 5.3 `albums`, `tags`, `meta`

```sql
CREATE TABLE albums (
  album        TEXT PRIMARY KEY,
  item_count   INTEGER NOT NULL DEFAULT 0,
  cover_item_id TEXT,
  updated_at   INTEGER
);

CREATE TABLE tags (
  item_id TEXT NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- schema_version, last_list_token, last_index_at, last_derive_at, last_dedupe_at
```

### 5.4 Dedupe tables

See §4.5 (`duplicate_groups`, `duplicate_members`). Duplicate detection is a
first-class capability of the catalog, not an afterthought.

---

## 6. Search: how FTS5 answers "gopro"

- SQLite B-tree indexes handle `=`, ranges, and prefixes. They cannot answer
  `LIKE '%gopro%'` without scanning every row.
- FTS5 maintains an inverted index (token → row ids). `MATCH 'gopro'` is a
  dictionary lookup.
- The scan cost is paid once at index time, not per query.
- FTS covers **text** (filename, album, tags, OCR, transcript), not pixels.
  "Photos *taken with* a GoPro" is an EXIF column query
  (`camera_make = 'GoPro'`); "photos *of* a GoPro" needs ML labels indexed as
  text.
- Prefix search works (`gopro*`); typos and mid-word substrings need the
  `trigram` tokenizer.

### 6.1 Measured reality (this host, 2026-11-06)

Synthetic 1,000,000-row database, 90 MB structured / 120 MB with FTS:

| Query | Plan / mechanism | Time |
|---|---|---:|
| `SELECT count(*)` | full count | ~2–7 ms |
| Keyset timeline page (50 rows) | index range scan | **~2 ms** |
| Album filter (5,000 rows) | index lookup | ~2 ms |
| Deep `OFFSET 900000` (wrong way) | walk + discard | ~353 ms |
| Full scan `GROUP BY media_type` | read all 1M rows | ~248 ms |
| `LIKE '%gopro%'` | full scan | ~95 ms |
| `MATCH 'gopro'` (FTS5) | inverted index | **~2 ms** |
| `MATCH 'gopro'` + join + page of 20 | index + 20 row reads | **~5 ms** |

Takeaways:

- Even the worst query over 1M rows is sub-second; the normal path is
  single-digit milliseconds.
- `LIKE` grows linearly (~2.4 s at 25M rows); FTS stays flat.
- Deep `OFFSET` is the one pattern to ban; keyset pagination is 100×+ faster.

---

## 7. Scaling thresholds

| Scale | Recommendation |
|---|---|
| **≤ 100k items** | Current setup is overkill-free. SQLite + FTS + Caddy. Optional static export. |
| **100k – 3M** | Home-server SQLite is the sweet spot. Consider sharding FTS by year if rebuild time grows. |
| **3M – 10M** | Shard the catalog by year/album into several `.db` files; or move row storage to Postgres on a VPS. Watch SSD capacity for thumbnails. |
| **> 10M / multi-user / public** | Postgres + Meilisearch/OpenSearch; or the deferred cloud path (Appendix A). |

**Move off SQLite when:**

1. DB exceeds ~50–80 GB or rebuilds exceed the maintenance window.
2. Concurrent writers appear (multi-user uploads).
3. Typo-tolerant/fuzzy search is required at scale (use Meilisearch).
4. Analytics over all rows becomes routine (use DuckDB/Parquet, Appendix B).
5. Availability must exceed this one box.

Duplicates affect thresholds directly: every byte reclaimed reduces B2 cost and
every purged row reduces catalog size. Keep dedupe in the routine loop even at
small scale.

---

## 8. Operations

### 8.1 Scheduled jobs (systemd timers)

| Job | Cadence | Purpose |
|---|---|---|
| `b2-indexer-index` | 15–60 min | List + diff + enqueue; nightly full re-list |
| `b2-indexer-derive` | after index / nightly | Process `status='listed'` and `failed` |
| `b2-indexer-dedupe-scan` | weekly | Refresh duplicate groups; report only |
| `b2-indexer-compact` | nightly/weekly | FTS `optimize`, tombstone prune, album counts |
| `library.db` backup | daily | `sqlite3 .backup` to a dated file |

Notes:

- Overlap must be prevented: timers must not start a second writer. Use
  `flock` or a lock file.
- Dedupe scans are safe to schedule; quarantine/purge are manual.
- Keep runs inside a bandwidth/time window for large backfills.
- `sqlite3 .backup` is safe online (unlike copying a live WAL file). Litestream
  is optional for continuous replication.

### 8.2 Daily / weekly checks

- Drift: objects in B2 vs rows in `items` (should be 0 unexplained).
- Derive failures list and retry count.
- Duplicate candidates and reclaimable bytes.
- `library.db` size growth vs item growth.
- Backups exist and restore.

### 8.3 Failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| New uploads not appearing | polling timer failed / lock stuck | Check timer logs; run index manually |
| Duplicate timeline entries | non-idempotent upsert | Dedupe by `item_id`/`object_key`; rebuild |
| Thumbnails missing | ffmpeg/sharp failure on a large file | Retry list; cap size; inspect log |
| Search stale | FTS not rebuilt after batch | Rebuild FTS; verify `optimize` ran |
| API slow | `OFFSET` pagination or missing index | Use keyset; check `EXPLAIN QUERY PLAN` |
| Presigned 403 | clock skew / key scope / TTL | Check NTP, key capabilities, TTL |
| Disk full | thumbnails exceeded SSD budget | Prune thumbnails; mirror derivatives to B2 |
| Purge refused | stale index / missing survivor | Re-run index/verify; restore or dismiss group |
| Purge deleted wrong copy | survivor not re-checked | Restore from B2 version; fix ranking; audit log |
| Quarantine storage not reclaimed | only hidden, not version-deleted | Run `dedupe:purge` after retention |

### 8.4 Disaster recovery

- Metadata is derivable: full re-list (free) + re-derive.
- Keep the Parquet/JSON export so a rebuild can skip re-download.
- Keep B2 keys in a password manager; never commit `.env`.
- Documented rebuild path: `index → derive → compact → serve`.
- If thumbnails are local-only, server loss means re-deriving every thumbnail.
- A purged duplicate is gone permanently; the audit log is the only record.
  Treat `--apply` accordingly.

---

## 9. Security and privacy

- **Buckets private.** No public ACLs. Presigned URLs only.
- **Least-privilege B2 keys**, scoped by bucket/capability; rotate. The purge
  key is separate and never used by the API or indexer.
- **Network exposure:** Tailscale-only by default. LAN access requires
  `basic_auth` in Caddy. Do not port-forward.
- **Auth:** one Caddy `basic_auth` block is enough for a single user. Avoid
  long-lived download tokens; presign per request with a short TTL.
- **Secrets:** in `.env` on the host or a password manager; never in the repo or
  client code.
- **Encryption:** TLS everywhere (Caddy internal CA or Tailscale certs); B2
  SSE-B2 at rest.
- **PII:** EXIF GPS is sensitive. Hide precise GPS in the UI by default; expose
  coarse location only on explicit request.
- **Abuse:** rate-limit `/api/search`; cap presign batch sizes; monitor egress.
- **Backups:** the catalog contains filenames and GPS; treat backups as
  sensitive.
- **Purge safety:** `--apply` is the only path to mutation, and the audit log is
  append-only.

---

## 10. Implementation plan

No infrastructure-as-code. One box, systemd timers, one Caddy block.

### Phase 0 — Foundations (1–2 days)

- [ ] Extract shared B2 logic into `lib/b2.js` (list pagination, download
      stream, presign, hide/delete). Keep `downloadFileById` where convenient.
- [ ] Define stable IDs (`item_id = sha1(bucket:file_id)`), dedupe keys
      (`contentSha1`), and reserved prefixes (`_derived/`, `_quarantine/`,
      `_index/`).
- [ ] Add `lib/db.js` (open/close, WAL, migrations via `meta.schema_version`).
- [ ] Add `lib/schema.js` (DDL + version) and `lib/media.js` (EXIF via
      `exiftool-vendored` or `sharp`; `ffprobe` parsing).
- [ ] Replace `thumbKey()` path flattening with a collision-free hash.
- [ ] Confirm the real object count and total bytes; record in `meta`.

**Acceptance:** a dry run indexes 1k objects into `library.db`, extracts
metadata, and a second run re-downloads zero unchanged objects.

### Phase 1 — Incremental inventory (2–3 days)

- [ ] Rewrite `index.js`: list → diff vs `items` → upsert `status='listed'`;
      mark missing rows `status='deleted'`.
- [ ] Add `npm run index:full` (ignore token) and `npm run index` (incremental).
- [ ] Store `last_list_token` and run timestamps in `meta`.
- [ ] Locking (`flock`) so timers never overlap.

**Acceptance:** adding one object to B2 and running the job produces exactly one
new row; deleting it produces a tombstone; re-running is a no-op.

### Phase 2 — Derivatives (3–5 days)

- [ ] Split `thumbs.js` into `lib/derive.js`; image grid + preview, video
      poster, audio art.
- [ ] Idempotent by `item_id` + derivative spec; skip when the source hash is
      unchanged and the file exists.
- [ ] `p-limit` concurrency; retry list for failures; do not fail the batch.
- [ ] Compute `phash` for images (optional flag `DERIVE_PHASH`).
- [ ] Derivatives stay local-only for v1.

**Acceptance:** derivatives for 10k mixed items; a re-run creates zero
duplicates; failures land in a retry list.

### Phase 3 — Catalog + FTS (2–3 days)

- [ ] Build `items_fts` (rebuild after batches, or triggers for incremental).
- [ ] Add `albums` and `tags` population; album cover selection.
- [ ] `compact.js`: FTS `optimize`, tombstone pruning, album counts.
- [ ] Add `npm run catalog`, `npm run compact`, `npm run verify`.

**Acceptance:** `MATCH 'gopro'` and camera-model queries return correct rows in
single-digit ms on a 100k library; re-running catalog build is idempotent.

### Phase 4 — API (3–4 days)

- [ ] `server.js` with `better-sqlite3`; `/timeline`, `/search`, `/albums`,
      `/duplicates`, `/items/:id/stream`.
- [ ] Keyset pagination; input validation; rate limiting.
- [ ] Presign B2 URLs (short TTL); `302` for originals/video.
- [ ] Contract tests with fixtures.

**Acceptance:** p95 `/search` < 100 ms on a 1M-row catalog; correct pagination;
presigned URL expires and refreshes.

### Phase 5 — Web app + Caddy (3–5 days)

- [ ] SPA: timeline, albums, search, lightbox, video, download.
- [ ] Duplicate review screen (read-only; links to CLI approval workflow).
- [ ] Caddy site block + dnsmasq entry; `basic_auth` or Tailscale-only.
- [ ] Caching: hashed assets immutable; API `no-store`.
- [ ] Mobile layout, keyboard nav, error/empty states.

**Acceptance:** authenticated browse on desktop and phone over LAN and
Tailscale; unauthenticated requests get 401; video seeks via range requests.

### Phase 6 — Duplicate report (2–3 days)

- [ ] `lib/dedupe.js`: exact grouping by `content_sha1`; `--near` phash
      clustering with banded LSH.
- [ ] `dedupe:scan`, `dedupe:report`; write group/member rows and reports.
- [ ] Survivor ranking (§4.4) and per-group reasons in the report.
- [ ] Scheduler entry (weekly, report only).

**Acceptance:** injected duplicate fixtures produce the expected groups,
survivors, and reclaimable-byte totals; scans make zero B2 writes.

### Phase 7 — Guarded purge (2–3 days)

- [ ] `dedupe:approve` with survivor validation.
- [ ] `dedupe:quarantine --apply`: fresh-listing verification, `b2_hide_file`,
      derivative cleanup, `status='quarantined'`, audit log.
- [ ] `dedupe:purge --apply --older-than`: `b2_delete_file_version` after
      retention, batch cap, FTS/album cleanup, reclaimed-byte accounting.
- [ ] `dedupe:verify`: re-list and integrity assertions.
- [ ] Purge key loading isolated to this CLI path only.

**Acceptance:** on a disposable test bucket, an exact-duplicate group can be
hidden, restored, re-hidden, purged, and verified; no survivor is ever touched;
the audit log matches B2 listings.

### Phase 8 — Deferred / optional

- [ ] Parquet export + DuckDB analytics (Appendix B).
- [ ] Event-driven ingest via Tailscale Funnel (keep reconciliation).
- [ ] ML enrichment: Rekognition labels/faces, OCR, transcripts (batch, opt-in).
- [ ] Old-version cleanup (`b2_list_file_versions`) beyond live-name dedupe.
- [ ] On-demand H.264 proxies for unsupported codecs.
- [ ] Derivative mirroring to B2 `_derived/`.
- [ ] Cloud migration only if a §7 trigger is crossed (Appendix A).

### 10.1 Repo changes summary

| Current | Fate |
|---|---|
| `index.js` | Rewrite as incremental inventory; move logic to `lib/b2.js` |
| `thumbs.js` | Split into `lib/derive.js`; keep a CLI wrapper |
| `download_links.js` | Replace with per-request presign in the API; keep a CLI for exports |
| `generate_albums.js` | Fold into the catalog build (albums are a query) |
| `generate_site.js` / `generate_site_albums.js` | Keep as a static export fallback; primary UI is the SPA |
| `lib/common.js` | Split into `lib/config.js`, `lib/b2.js`, `lib/db.js`, `lib/media.js`, `lib/schema.js`, `lib/dedupe.js` |
| `dist/` | Local build/cache output (thumbs, static app); not canonical |
| `data/library.db` | New: canonical local catalog (rebuildable) |
| `data/duplicate-report.*`, `data/purge-log.jsonl` | New: dedupe review and audit outputs |

### 10.2 Dependencies to add

- `better-sqlite3` (synchronous SQLite; native, Node 20+).
- `exiftool-vendored` (or extend `sharp` metadata) for EXIF.
- `ffprobe` via `child_process` (ffmpeg already required).
- Optional: `duckdb` (Parquet export/analytics), `litestream` (backups).

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Home server down | Gallery unavailable | Accept for personal use; bytes safe in B2; DB rebuildable |
| SSD capacity for thumbnails | Disk full at scale | Prune/regenerate; mirror derivatives to B2 when needed |
| Single-writer contention | Timer overlap / locked DB | `flock`, WAL, `busy_timeout` |
| Long first backfill | Hours–days of download | Windowed runs, resumable `status`, newest-first |
| FTS rebuild time grows | Long maintenance window | Incremental triggers; shard by year |
| Unsupported codecs | Broken playback | Detect; download fallback; optional proxies |
| LAN exposure | Unauthorized access | Tailscale-only or `basic_auth`; no port forward |
| Presigned URL leakage | Temporary access | Short TTL; scope key to read/presign |
| GPS privacy | Sensitive metadata exposed | Hide precise GPS by default |
| Scope creep into ML | Cost/time sink | Phase 8, optional, separate pipeline |
| Near-dupe false positive | Wrong photo hidden | Review-only; retention; never auto-purge |
| Survivor mis-selection | Loss of preferred copy | Deterministic ranking; approval; pre-mutation checks |
| Purge key compromise | Bucket deletion | Separate key, CLI-only, rotate, audit log |
| Hidden objects still billed | Cost not reclaimed | `dedupe:purge` after retention; report hidden bytes |
| Duplicate scan O(n²) | Time sink at scale | Blocking + LSH; time-window and prefix limits |

---

## Appendix A — Deferred cloud path (not in scope)

Revisit only if a §7 trigger is crossed: public/multi-user serving, availability
beyond this box, or serverless batch execution.

The earlier AWS-first design was intentionally removed from the delivery plan.
If it is ever needed, the shape would be: B2 event notifications → API
Gateway/Lambda → SQS → worker with `sharp`/`ffprobe` → derivatives in B2 →
metadata in DynamoDB/S3 Parquet → a serving index loaded from S3. Constraints
remembered from that draft:

- No Firehose; write Parquet from a batch job.
- Athena for analytics only, never the hot UI path.
- Never serve media through AWS; egress at ~$0.09/GB destroys the cost model.
- Events are at-least-once and can be suspended; polling reconciliation stays
  mandatory.
- Derivatives must live in a separate bucket or reserved prefix to avoid
  re-trigger loops.

This path is not planned, not estimated, and not a dependency of anything above.

---

## Appendix B — Parquet + DuckDB analytics (optional local)

Keep the serving path in SQLite; use DuckDB for ad-hoc slicing over all rows.

- Export `items` to Parquet: `COPY (SELECT * FROM items) TO 'catalog.parquet'`.
- Run DuckDB directly against exported Parquet for group-bys, camera statistics,
  and date histograms.
- Parquet is portable and cheap to keep; copy to S3 only for offsite archive.
- Do not put DuckDB in the per-request web path; rebuild/query it offline.
- Dedupe reports can also be exported to Parquet for long-term trend analysis.

---

## Appendix C — Cost model

Assumptions: B2 originals $6.95/TB-month; derivatives ~60 KB/item if mirrored;
local compute/disk already owned; AWS portion $0.

| Line item | 100k items / 1 TB | 1M items / 10 TB | 10M items / 100 TB |
|---|---:|---:|---:|
| B2 originals | $6.95 | $69.50 | $695.00 |
| B2 derivatives (if mirrored) | $0.04 | $0.42 | $4.17 |
| Home server (power/disk, already paid) | — | — | — |
| Caddy / Node / SQLite | $0 | $0 | $0 |
| **Total (approx.)** | **~$7.00** | **~$70** | **~$699** |

Notes:

- Storage dominates. Optimize bytes first: duplicate purging, derivative sizes,
  and lifecycle—not compute.
- Every exact duplicate purged removes its full size from the monthly bill.
- B2 egress is free up to 3× average stored per month, then $0.01/GB. A
  Bandwidth Alliance CDN (Cloudflare, bunny.net, Fastly) makes B2 egress free.
- Local SSD is the hidden cost: at 10M items, thumbnails alone are ~600 GB.
- Compare: 10 TB in S3 Standard is ~$230/mo before egress; B2 at ~$70/mo for
  always-hot data is the right trade-off.

---

## Appendix D — Glossary

- **Derivative**: any generated artifact (thumbnail, preview, poster, proxy).
- **Serving index**: the local SQLite FTS5 database the API reads.
- **Tombstone**: a row marking an item deleted, keeping history.
- **Keyset pagination**: paging by `(taken_at, id)` cursor instead of `OFFSET`.
- **Inverted index**: token → row-id map; what makes `MATCH` fast.
- **Exact duplicate**: identical bytes, identified by `content_sha1`.
- **Near-duplicate**: visually similar but not byte-identical, identified by a
  perceptual hash and Hamming distance.
- **Quarantine**: hiding a duplicate in B2 for a retention period before
  permanent deletion; reversible.
- **Purge**: permanently deleting a specific B2 file version to reclaim bytes.
- **Survivor**: the one member of a duplicate group that is retained.
- **Bandwidth Alliance**: CDN partners that peer with Backblaze, making B2
  egress free.

---

## Appendix E — Sources (verify before committing)

Sources for the finalized home-server scope:

- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
- Backblaze transaction pricing: https://www.backblaze.com/cloud-storage/transaction-pricing
- B2 file versions / hide / delete: https://www.backblaze.com/docs/cloud-storage-file-versions
- SQLite FTS5: https://sqlite.org/fts5.html
- SQLite limits: https://sqlite.org/limits.html
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- Caddy reverse_proxy / file_server / basic_auth: https://caddyserver.com/docs/

Deferred cloud path only (Appendix A), not part of this plan:

- B2 Event Notifications: https://www.backblaze.com/docs/cloud-storage-event-notifications-reference-guide
- AWS Athena / S3 / CloudFront / Lambda pricing:
  https://aws.amazon.com/athena/pricing/,
  https://aws.amazon.com/s3/pricing/,
  https://aws.amazon.com/cloudfront/pricing/,
  https://aws.amazon.com/lambda/pricing/
