# Plan: Scaling `b2-indexer` into a Self-Hosted Photo/Media Library

**Status:** Revised draft — home-server-first
**Date:** 2026-11-06
**Author:** Darwin Biler
**Scope:** Architecture, cost model, and phased implementation. No code in this document.

> **Revision note.** This supersedes the earlier AWS-first draft. The default
> deployment is now **this home server** (Gmktec M5 Plus): it runs the indexing,
> owns the local SQLite catalog, and serves the web app over LAN/Tailscale.
> B2 remains the system of record for bytes. AWS is demoted to an optional
> escape hatch for later (Appendix A), used only when a concrete threshold is
> crossed.

---

## 0. TL;DR

The goal is a self-hosted Google Photos: media lives in a Backblaze B2 bucket you
own, one always-on home server indexes it, and a small web app lets you
browse/search it at terabyte scale.

**Recommended shape:**

- **B2** = media origin (originals + optional derivatives). Never duplicated.
- **Home server** = indexer + local **SQLite** catalog with **FTS5** + Node API.
- **Caddy** = HTTPS, static app, reverse proxy, auth. Replaces CloudFront/API
  Gateway entirely.
- **Access** = LAN (`192.168.0.4`) and Tailscale (`100.81.195.27`) by default.
- **AWS** = optional; only if you later need public multi-user serving,
  availability beyond this box, or serverless job execution.

**Why this is cheaper and simpler than the AWS-first draft:**

- The plan's AWS control plane existed to avoid an always-on box. You already
  have one, on the same LAN, with the CPU for `sharp`/`ffmpeg`.
- DynamoDB + Lambda `/tmp` SQLite + Athena-in-the-UI collapse into **one
  `library.db` file**.
- Nightly/hourly **polling reconciliation** replaces webhook + SQS + DLQ; B2
  listing is free (Class C) and a full re-list is a valid recovery path.
- No NAT Gateway, no Firehose, no Glue crawlers, no CloudFront egress, no
  serverless cold starts.
- At-rest cost is dominated by B2 storage (~$7/TB/month). The AWS portion is
  **$0**.

**Key properties:**

- Originals are **never re-uploaded**. Bytes flow B2 → server once for
  metadata/thumbnails; the server writes JSON/rows locally.
- The SQLite catalog is a **rebuildable derived index**, not a second source of
  truth. Delete it any time and rebuild from B2.
- Media is delivered **browser ↔ B2 directly** via short-TTL presigned URLs, so
  the home uplink never carries full-res video.
- Terabytes are in B2. The DB holds **~0.5–1.5 KB per object**; 1M items ≈
  1–1.5 GB, 25M items ≈ 25–30 GB.

---

## 1. Goals, Constraints, Non-Goals

### Goals

1. **Browse and search** a B2 bucket containing images, video, and audio.
2. **Cheap at rest**: terabytes of media should cost storage rates, not compute
   or egress rates.
3. **Cheap when idle**: no managed database, no cluster, no always-billed cloud
   service.
4. **Scalable**: from 10k to ~10M objects without re-architecting.
5. **Own your data**: media stays in B2; metadata is a portable SQLite/Parquet
   file, not locked into a proprietary service.
6. **Good UX**: timeline, albums, date filters, keyword search, thumbnails,
   video playback, downloads.
7. **Secure by default**: private bucket, least-privilege keys, LAN/Tailscale
   access, authenticated app.
8. **Undemanding operations**: one box, a few systemd timers, one Caddy site.

### Constraints

- B2 is the system of record for bytes. Do not duplicate originals into S3 or
  onto the home disk.
- The home server is a single machine (Ryzen 7 5825U, 16 GB RAM, 1 TB SSD),
  behind double NAT, on the LAN at `192.168.0.4`, reachable over Tailscale at
  `100.81.195.27`.
- Existing repo is CommonJS Node.js with a CLI pipeline and `dist/` output.
  Node >= 20.9.0.
- `ffmpeg` is available on the host; `sharp` is already a dependency.
- Media may include formats browsers cannot play natively (HEVC/MOV); handle
  gracefully, do not assume transcoding.
- Local disk is finite: 1 TB total, shared with other services.

### Non-Goals (for v1)

- Multi-tenant SaaS.
- Real-time collaborative editing.
- Automatic ML face clustering / semantic search (design a hook, defer).
- Video transcoding of the entire library (expensive; opt-in proxies only).
- Perfect real-time consistency. Minutes-to-hours eventual consistency is fine.
- High availability. If this server is down, the gallery is down; bytes remain
  safe in B2.

---

## 2. Where the Codebase Is Today

Current pipeline (`index.js` → `thumbs.js` → `download_links.js` →
`generate_albums.js` → `generate_site*.js`) is a good prototype with these
scaling limits:

| Area | Current behavior | Problem at scale |
|---|---|---|
| Listing | `b2.listFileNames` full scan into `dist/index.jsonl` | Full rescan every run; no watermark or diff |
| Thumbnails | Downloads each original, resizes with `sharp`/`ffmpeg` locally | Single machine, concurrency 5; no incremental tracking |
| Thumbnail naming | Flattens `/` to `_` | Cross-folder collisions |
| Downloads | Pre-generates a token URL for every file into one JSON | Tokens expire (~7 days); file grows unbounded; leaks download capability |
| Albums | First path segment only | No capture-date albums, tags, or search |
| Site | Pre-rendered static HTML, 50/page | No search; page count grows linearly |
| Metadata | Name, size, contentType, sha1, upload time | No EXIF, GPS, dimensions, duration, dedupe hash |
| Auth | None | Public static output |
| Idempotency | File existence check | No durable per-object state; renames/deletes not handled |

Keep the good parts: streaming JSONL, atomic writes, `sharp`/`ffmpeg` logic,
B2 native download-by-id, `EXCLUDE_PATHS`.

---

## 3. Recommended Architecture (Home-Server-First)

### 3.1 Design principles

1. **Three planes on one box.**
   - **Media plane** (huge): B2 originals + optional derivatives. Never copied
     locally at full size.
   - **Metadata plane** (small): `library.db` (SQLite) + `dist/thumbs/`.
   - **Control plane** (tiny): systemd timers, the Node API, Caddy.
2. **Download once, derive once.** Each original is read once for EXIF/ffprobe
   and thumbnails. Serving never re-reads originals.
3. **B2 is truth; SQLite is a cache.** The catalog can always be rebuilt by
   re-listing (free) and re-deriving.
4. **The app never lists the bucket.** It queries indexed rows only.
5. **Everything idempotent.** Upsert by a stable key; re-runs are safe.
6. **One writer.** The indexer writes; the API reads. WAL mode for concurrent
   reads.
7. **Two-tier realism.** Start with polling + SQLite. Add queues, webhooks, or
   the cloud only when a measured threshold is crossed.

### 3.2 Target diagram

```
 ┌──────────────────────── Backblaze B2 (private) ────────────────────────┐
 │  media/…                 originals (images / video / audio)            │
 │  _derived/thumbs/…       optional thumbnails (survive server loss)     │
 │  _derived/previews/…     optional larger previews / proxies            │
 └───────────┬──────────────────────────────────────────┬─────────────────┘
             │ b2_list_file_names (free, polled)        │ S3-compatible GET
             │ b2_download_file_by_id (once per item)   │ / presigned URL
             ▼                                          │
 ┌──────────────────── Home server (this box) ──────────┼─────────────────┐
 │  systemd timers                                       │                 │
 │    index.js    list → diff vs library.db → enqueue    │                 │
 │    derive.js   download → sharp/ffprobe → thumbnail   │                 │
 │                     → upsert row (status=derived)     │                 │
 │    compact.js  rebuild/optimize FTS, prune tombstones │                 │
 │                                                       │                 │
 │  library.db  (SQLite WAL)                             │                 │
 │    items / albums / tags / items_fts / meta           │                 │
 │                                                       │                 │
 │  server.js   Node API (better-sqlite3)                │                 │
 │    /api/timeline /api/search /api/albums              │                 │
 │    /api/items/:id/stream → 302 presigned B2 URL ──────┘                 │
 │                                                       │                 │
 │  Caddy :443  photos.home.local                        │                 │
 │    /      → file_server  dist/ (SPA + thumbs/)        │                 │
 │    /api/* → reverse_proxy localhost:8090              │                 │
 └───────────┬───────────────────────────────────────────┘                 │
             │ LAN 192.168.0.4  /  Tailscale 100.81.195.27                  │
             ▼                                                               │
        Browser (desktop + phone) ──── fetch thumbnails from Caddy           │
                                    └ fetch originals directly from B2 ─────┘
```

### 3.3 B2 layout and keys

```
<bucket>/
  media/2024/2024-07-…            # originals (user uploads)
  _derived/thumbs/…               # 256px webp/avif grid (optional mirror)
  _derived/previews/…             # 1024–1600px webp lightbox (optional)
  _derived/posters/…              # video poster frames (optional)
```

- Reserved prefixes (`_derived/`, `_index/`) are **excluded** from the indexer
  and from any future event rule. The existing `EXCLUDE_PATHS` is the right
  instinct; make reserved prefixes non-configurable.
- Application keys, least privilege:
  - `indexer-ro`: list + download (Class B/C), no write.
  - `deriver-wo` (only if mirroring derivatives): write only under `_derived/`.
  - `app-ro`: download authorization / presign only.
- Private bucket. If a public gallery mode is ever wanted, use a separate bucket
  and explicit lifecycle, never the same key.
- Thumbnails are **regenerable**, so local-only storage is valid. Mirroring to
  B2 `_derived/` buys faster rebuilds after disaster at the cost of storage and
  one upload per item. Decide by disk budget: at 10M items the thumbnail set is
  ~600 GB, which will not fit beside everything else on the 1 TB SSD.

### 3.4 Ingestion: polling reconciliation (primary)

B2 object-change webhooks require support enablement and a reachable HTTPS
endpoint. This box is behind double NAT, so the default is polling:

```
every 15–60 min (or nightly for a cold library):
  b2_list_file_names (paginate; free, Class C)
    → compare fileId + contentSha1 + size against items
    → new/changed  → status='listed', enqueue derive
    → missing      → status='deleted', deleted_at=now (tombstone)
    → unchanged    → nothing
```

Properties:

- No webhook, no public endpoint, no SQS, no signature verification.
- At-least-once is irrelevant: the diff is idempotent by construction.
- A full re-list is both the routine job and the disaster-recovery path.
- Listing millions of names is cheap but not instant; store the continuation
  token and resume if a run exceeds its window.
- **Never** write derived artifacts into a prefix the indexer scans. That is the
  infinite-loop trap: upload thumb → event/list sees a new object → derive again.

**Optional later: event-driven.** If real-time ingest becomes desirable, expose
a webhook through Tailscale Funnel or Cloudflare Tunnel (never a raw port
forward), verify HMAC, and keep reconciliation as the mandatory safety net.
Events are at-least-once and rules can be suspended; polling must remain.

### 3.5 Indexing and derivation pipeline

Two passes, and only the second downloads:

**Pass 1 — inventory (free).** `b2_list_file_names` already returns
`fileName`, `contentLength`, `contentSha1`, `contentType`, `fileId`,
`uploadTimestamp`. Upsert those immediately:

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
  → thumbnail → dist/thumbs/xxx.tmp → rename  (atomic; existing pattern)
  → UPDATE items SET taken_at, width, height, camera_make, camera_model,
                     gps_lat, gps_lon, duration_ms, thumb_key,
                     status='derived', indexed_at=now
```

- Original bytes are discarded after processing. Nothing is uploaded back.
- `status` (`listed` | `derived` | `failed` | `deleted`) makes runs resumable;
  a crash leaves no orphaned rows and the next run picks up where it stopped.
- Thumbnail names must be collision-free. The current `thumbKey()` flattens `/`
  to `_`; replace it with `sha1(object_key)` or a normalized path hash.
- Concurrency via `p-limit`; `THUMBNAIL_CONCURRENCY` stays. For a large
  backfill, prioritize newest-first so the timeline is usable early.
- Large videos can exceed a comfortable single-process budget; cap file size for
  in-process derivation and put the rest on a retry list.

**One-time cost:** the first derivation must read the whole library once. At
100 MB/s, 10 TB is roughly 28 hours of sustained download. Throttle by window
(e.g. overnight) and let `status` resume across runs. B2 egress for this is free
within the 3× monthly allowance.

### 3.6 Local catalog (SQLite)

One file: `data/library.db`. SQLite in WAL mode, `busy_timeout` set, single
writer (the indexer). Full schema in §5.

- Size is proportional to object count, not media size: ~0.5–1.5 KB/row.
- `items` holds structured columns; `items_fts` is the inverted text index.
- `meta` holds `schema_version`, last list token, last run timestamps.
- Rebuilding into `library.db.tmp` then `rename()` gives an atomic catalog swap,
  matching the `writeJsonAtomic` pattern already in `lib/common.js`.

### 3.7 Serving: Caddy + Node API

Caddy already runs on this host with internal TLS and split-DNS hostnames. Add
one site block:

```caddyfile
photos.home.local {
    root * /home/darwin/Code/b2-indexer/dist

    handle /api/* {
        reverse_proxy localhost:8090
    }
    handle {
        file_server
        encode gzip
    }

    # optional for LAN access; omit when bound to Tailscale only
    basic_auth {
        darwin $2a$14$...
    }

    tls internal
}
```

- dnsmasq entry in `/etc/dnsmasq.d/internal.conf`, following the existing
  convention (map the name to `100.81.195.27` for Tailscale; LAN clients can use
  `192.168.0.4`).
- The API is a single Node process with `better-sqlite3` (synchronous, one
  query per request, no pool). Expose four read endpoints:

```
GET /api/timeline?year=&cursor=
GET /api/search?q=&from=&to=&album=&type=&cursor=
GET /api/albums
GET /api/items/:id/stream   -> 302 to short-TTL B2 presigned URL
```

- Keyset pagination on `(taken_at DESC, id)`, never `OFFSET` at depth.
- Static SPA and thumbnails come from `file_server`; the API returns metadata
  and a signed media URL only.

### 3.8 Media delivery

- **Thumbnails**: local disk via Caddy. Instant on LAN, zero egress.
- **Originals/video**: `302` redirect to a B2 presigned URL (5–15 min TTL,
  per request). The browser pulls bytes straight from B2; the home uplink is not
  in the path.
  - Consequence: LAN playback still traverses the WAN to B2. That is the price
    of not storing 100 TB locally. B2 supports range requests, so seeking works.
  - Do **not** proxy media through Node/Caddy: it saturates the home uplink and
    ties up the process.
- Unsupported codecs: detect with `ffprobe`; offer download fallback; optionally
  generate an H.264 proxy on demand into `_derived/`. Never transcode the whole
  library by default.

### 3.9 Web app

- SPA (React/Vue/Svelte) in `dist/`, served by Caddy.
- Views: timeline (infinite scroll, grouped by month), albums, search, item
  detail/lightbox, video player, download.
- Thumbnails: lazy-loaded, `srcset`, `loading="lazy"`, content-visibility for
  long timelines.
- Search: debounce 250–300 ms, cancel in-flight requests, show skeletons.
- Offline/PWA optional.

### 3.10 Request flows

**Upload → visible**

```
rclone uploads to B2 media/…
  → next polling run sees a new fileId
  → status='listed' → derive: download, EXIF/ffprobe, thumbnail
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

---

## 4. Current-Flow Clarification

A frequent point of confusion, stated explicitly:

| Question | Answer |
|---|---|
| Does indexing download the original? | Yes, once, for EXIF/thumbnails. Streamed and discarded. |
| Does it upload the original back to B2? | **No.** It is already there. |
| Where does the metadata row go? | `data/library.db` (local SQLite). |
| Where does the thumbnail go? | `dist/thumbs/` (local), optionally mirrored to B2 `_derived/`. |
| What does the web server read? | SQLite rows + local thumbnails. |
| What does the browser fetch for full-res? | Directly from B2 via a presigned URL. |

```
B2 originals (untouched)
   │  list (free) ──► diff vs library.db ──► only new/changed
   │  download (streamed, once)
   ▼
sharp / ffprobe ──► metadata ──► UPSERT items (local SQLite)
                └─► thumbnail ──► dist/thumbs/ (or B2 _derived/, optional)
```

---

## 5. Data Model

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
  phash         TEXT,                   -- optional perceptual hash
  status        TEXT NOT NULL DEFAULT 'listed',
  indexed_at    INTEGER,
  updated_at    INTEGER,
  deleted_at    INTEGER
);

CREATE INDEX items_timeline ON items(taken_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX items_album ON items(album, taken_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX items_type ON items(media_type, taken_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX items_camera ON items(camera_make, camera_model);
CREATE INDEX items_sha1 ON items(content_sha1);
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
- Because `items` does not itself carry `tags`/`ocr_text` in the sketch above,
  either add those columns to `items` or use a separate `item_text` table joined
  to the FTS index. Pick one; keep it consistent.
- Keep in sync with triggers for incremental changes, or run a `'rebuild'` after
  each batch (simple, and fast enough for batch indexing).
- Run `INSERT INTO items_fts(items_fts) VALUES('optimize')` after large batches
  to merge index segments.
- Tokenizer choice: `unicode61` is exact-token; add `porter` for English
  stemming, or `trigram` if typo/substring search is required (larger index).

### 5.3 `albums`, `tags`, `meta`

```sql
CREATE TABLE albums (
  album     TEXT PRIMARY KEY,
  item_count INTEGER NOT NULL DEFAULT 0,
  cover_item_id TEXT,
  updated_at INTEGER
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
-- schema_version, last_list_token, last_index_at, last_derive_at
```

### 5.4 Dedupe

- Exact: `content_sha1` (free from B2 listing).
- Near-dupe: optional `phash` Hamming distance.
- Keep a `duplicate_of` pointer rather than deleting; reclaim storage later,
  after review.

---

## 6. Search: How FTS5 Actually Answers "gopro"

This section exists because it is the most counter-intuitive part.

- SQLite's normal B-tree indexes handle `=`, ranges, and prefixes. They cannot
  answer `LIKE '%gopro%'` without scanning every row.
- FTS5 maintains an **inverted index**: token → row ids. `MATCH 'gopro'` is a
  dictionary lookup, not a scan.
- The "scan everything" cost is paid **once at index time**, during
  `'rebuild'` / incremental inserts. At query time it is a lookup.
- Scope matters: FTS covers **text** (filename, album, tags, OCR, transcript).
  It does not understand pixels. "Photos *taken with* a GoPro" is an EXIF column
  query (`camera_make = 'GoPro'`); "photos *of* a GoPro" needs ML labels that
  are then indexed as text.
- Prefix search works (`gopro*`); typos and mid-word substrings do not, unless
  the `trigram` tokenizer is used.

### 6.1 Measured reality (this host, 2026-11-06)

Synthetic 1,000,000-row database, 90 MB (structured) / 120 MB (with FTS):

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
- `LIKE` grows linearly with row count (~2.4 s at 25M rows); FTS stays flat.
- Deep `OFFSET` is the one query pattern to ban; keyset pagination is 100×+
  faster.

---

## 7. Scaling Thresholds

| Scale | Recommendation |
|---|---|
| **≤ 100k items** | Current setup is overkill-free. SQLite + FTS + Caddy. Optional: fully static export. |
| **100k – 3M** | Home-server SQLite is the sweet spot. Consider sharding FTS by year if rebuild time grows. |
| **3M – 10M** | Shard the catalog by year/album into several `.db` files; or move row storage to Postgres on a VPS. Watch SSD capacity for thumbnails. |
| **> 10M / multi-user / public** | Postgres + Meilisearch/OpenSearch; or the AWS reference architecture (Appendix A). |

**When to move off SQLite (concrete triggers):**

1. DB exceeds ~50–80 GB or rebuilds exceed the maintenance window.
2. Concurrent writers appear (multi-user uploads).
3. Typo-tolerant/fuzzy search is required at scale (use Meilisearch).
4. Analytics over all rows becomes routine (use DuckDB/Parquet, Appendix B).
5. Availability must exceed this one box (move to AWS/VPS).

**When to add Athena:** almost never. Keep Parquet + DuckDB locally for
analytics; export to S3 only if you want offsite/portable archives.

---

## 8. Operations

### 8.1 Scheduled jobs (systemd timers)

| Job | Cadence | Purpose |
|---|---|---|
| `b2-indexer-index` | 15–60 min | List + diff + enqueue; nightly full re-list |
| `b2-indexer-derive` | after index / nightly | Process `status='listed'` and `failed` |
| `b2-indexer-compact` | nightly/weekly | FTS `optimize`, tombstone prune, album counts |
| `library.db` backup | daily | `sqlite3 .backup` to a dated file |

Notes:

- Overlap must be prevented: timers must not start a second writer. Use a lock
  file or `flock`.
- Keep runs inside a bandwidth/time window for large backfills.
- `sqlite3 .backup` is safe online (unlike copying a live WAL file). Consider
  Litestream if continuous replication to B2/S3 is wanted.

### 8.2 Daily / weekly checks

- Drift: objects in B2 vs rows in `items` (should be 0 unexplained).
- Derive failures list and retry count.
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
| Disk full | thumbnails exceeded SSD budget | Move derivatives to B2 `_derived/` |

### 8.4 Disaster recovery

- Metadata is derivable: full re-list (free) + re-derive.
- Prefer keeping the Parquet/JSON export so a rebuild can skip re-download.
- Keep B2 keys in a password manager; never commit `.env`.
- Documented rebuild path: `index → derive → compact → serve`.
- If thumbnails are local-only, a server loss means re-deriving every thumbnail
  (a full re-download). Mirroring to B2 `_derived/` trades storage for a much
  shorter recovery.

---

## 9. Security and Privacy

- **Buckets private.** No public ACLs. Presigned URLs only.
- **Least-privilege B2 keys**, scoped by bucket/capability; rotate.
- **Network exposure:** default to Tailscale-only. If LAN access is needed, add
  `basic_auth` in Caddy. Do not port-forward.
- **Auth:** one Caddy `basic_auth` block is enough for a single user. Avoid
  long-lived download tokens; presign per request with a short TTL.
- **Secrets:** in `.env` on the host or a password manager; never in the repo,
  never in client code.
- **Encryption:** TLS everywhere (Caddy internal CA; trust it on devices, or use
  Tailscale certs); B2 SSE-B2 and S3 SSE-S3 at rest.
- **PII:** EXIF GPS is sensitive. Default to hiding precise GPS in the UI;
  expose coarse location only on explicit request.
- **Abuse:** rate-limit `/api/search`; cap presign batch sizes; monitor egress.
- **Backups:** the database contains filenames and GPS; treat backups as
  sensitive.

---

## 10. Implementation Plan

No infrastructure-as-code needed for the default path. One box, systemd timers,
one Caddy block. Keep AWS/CDK out until Appendix A is actually triggered.

### Phase 0 — Foundations (1–2 days)

- [ ] Extract shared B2 logic into `lib/b2.js` (list pagination, download
      stream, presign, key scoping). Keep `downloadFileById` where convenient.
- [ ] Define stable IDs (`item_id = sha1(bucket:file_id)`), dedupe keys
      (`contentSha1`), and reserved prefixes (`_derived/`, `_index/`).
- [ ] Add `lib/db.js` (open/close, WAL, migrations via `meta.schema_version`).
- [ ] Add `lib/schema.js` (DDL + version) and `lib/media.js`
      (EXIF via `exiftool-vendored` or `sharp`; `ffprobe` parsing).
- [ ] Replace `thumbKey()` path flattening with a collision-free hash.

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
- [ ] Decide derivative storage: local only, or mirror to B2 `_derived/`
      (weigh 1 TB SSD budget).

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
      `/items/:id/stream`.
- [ ] Keyset pagination; input validation; rate limiting.
- [ ] Presign B2 URLs (short TTL); `302` for originals/video.
- [ ] Contract tests with fixtures.

**Acceptance:** p95 `/search` < 100 ms on a 1M-row catalog; correct pagination;
presigned URL expires and refreshes.

### Phase 5 — Web app + Caddy (3–5 days)

- [ ] SPA: timeline, albums, search, lightbox, video, download.
- [ ] Caddy site block + dnsmasq entry; `basic_auth` or Tailscale-only.
- [ ] Caching: hashed assets immutable; API `no-store`.
- [ ] Mobile layout, keyboard nav, error/empty states.

**Acceptance:** authenticated browse on desktop and phone over LAN and
Tailscale; unauthenticated requests get 401; video seeks via range requests.

### Phase 6 — Optional

- [ ] Parquet export + DuckDB analytics (Appendix B).
- [ ] Event-driven ingest via Tailscale Funnel (keep reconciliation).
- [ ] ML enrichment: Rekognition labels/faces, OCR, transcripts (batch, opt-in).
- [ ] Duplicate reclamation after review.
- [ ] On-demand H.264 proxies for unsupported codecs.
- [ ] AWS migration only if a §7 trigger is crossed (Appendix A).

### 10.1 Repo changes summary

| Current | Fate |
|---|---|
| `index.js` | Rewrite as incremental inventory; move logic to `lib/b2.js` |
| `thumbs.js` | Split into `lib/derive.js`; keep a CLI wrapper |
| `download_links.js` | Replace with per-request presign in the API; keep a CLI for exports |
| `generate_albums.js` | Fold into the catalog build (albums are a query) |
| `generate_site.js` / `generate_site_albums.js` | Keep as a static fallback/exporter; primary UI is the SPA |
| `lib/common.js` | Split into `lib/config.js`, `lib/b2.js`, `lib/db.js`, `lib/media.js`, `lib/schema.js` |
| `dist/` | Local build/cache output (thumbs, static app); not canonical |
| `data/library.db` | New: canonical local catalog (rebuildable) |

### 10.2 Dependencies to add

- `better-sqlite3` (synchronous SQLite; native, Node 20+).
- `exiftool-vendored` (or extend `sharp` metadata) for EXIF.
- `ffprobe` via `child_process` (ffmpeg already required).
- Optional: `duckdb` (Parquet export/analytics), `litestream` (backups).

---

## 11. Risks and Open Questions

| Risk | Impact | Mitigation |
|---|---|---|
| Home server down | Gallery unavailable | Accept for personal use; bytes safe in B2; DB rebuildable |
| SSD capacity for thumbnails | Disk full at scale | Mirror derivatives to B2 `_derived/`; monitor |
| Single-writer contention | Timer overlap / locked DB | `flock`, WAL, `busy_timeout` |
| Long first backfill | Hours–days of download | Windowed runs, resumable `status`, newest-first |
| FTS rebuild time grows | Long maintenance window | Incremental triggers; shard by year |
| Unsupported codecs | Broken playback | Detect; download fallback; optional proxies |
| LAN exposure | Unauthorized access | Tailscale-only or `basic_auth`; no port forward |
| Presigned URL leakage | Temporary access | Short TTL; scope key to read/presign |
| GPS privacy | Sensitive metadata exposed | Hide precise GPS by default |
| Scope creep into ML | Cost/time sink | Phase 6, optional, separate pipeline |

**Open questions for Darwin**

1. **Expected object count and mix** (photos vs. video vs. audio)? This decides
   whether SQLite is enough or sharding is needed at launch.
2. **Single user or family/multi-user?** Affects auth and write concurrency.
3. **Is B2 already populated, or is this a new bucket?** Determines backfill
   scope and whether `contentSha1` dedupe is available.
4. **Is search mostly filenames/albums, or EXIF/camera, or OCR/ML?** Determines
   FTS tokenizer and whether ML is in scope.
5. **LAN access, Tailscale-only, or both?** Determines Caddy auth.
6. **Keep the current static HTML output** as an export, or replace it entirely
   with the SPA?
7. **Is transcoding required** for your video formats, or is download fallback
   acceptable?
8. **Do you want derivatives mirrored to B2** (recovery) or local-only (simpler,
   fits SSD)?

---

## Appendix A — AWS Reference Architecture (escape hatch, not default)

Use only if a §7 trigger is crossed: public/multi-user serving, availability
beyond this box, or serverless batch execution.

```
B2 (media, private)
  │ B2 Event Notifications (webhook, needs support enablement)
  ▼
API Gateway → webhook Lambda (verify HMAC, 200 in <3s) → SQS (+DLQ)
  → worker (Lambda container / Fargate): ffprobe, sharp, SQLite
  → thumbnail to B2 _derived/
  → metadata → S3 raw Parquet (ingest_date=…) → compacted catalog
  → DynamoDB state (item_id, etag, indexed_at, status)
  ▼
Serving index: SQLite FTS5 in S3, loaded by API Lambda to /tmp
  + Athena/Glue (partition projection) for ad-hoc analytics
  ▼
CloudFront (SPA + API + auth) → 302 to B2 presigned URLs
```

Key corrections retained from the earlier draft:

- Drop **Firehose**; write Parquet directly from a batch job.
- Athena is **analytics only**, never the hot UI path.
- "S3 static website + basic auth" does not exist; use CloudFront + auth
  function, Cognito, or Cloudflare Access.
- Never serve media through AWS; egress at ~$0.09/GB destroys the cost model.
- Partition the lake by ingest date, compact a derived catalog by **capture**
  month.
- Mandatory reconciliation: events are at-least-once and can be suspended.
- Derived artifacts must live in a separate bucket or reserved prefix to avoid
  re-trigger loops.

Cost guardrails if ever used: AWS Budgets alerts, Athena workgroup scan limit,
no NAT Gateway (keep Lambdas outside a VPC), no idle Aurora/OpenSearch, S3
lifecycle for compacted `raw/`.

---

## Appendix B — Parquet + DuckDB Analytics (optional local)

Keep the serving path in SQLite; use DuckDB when you need ad-hoc slicing over
all rows.

- Export `items` to Parquet: `COPY (SELECT * FROM items) TO 'catalog.parquet'`.
- Or run DuckDB directly against exported Parquet for group-bys, camera
  statistics, date histograms.
- Parquet is portable and cheap to keep; copy to S3 only for offsite archive.
- Do not put DuckDB in the per-request web path; rebuild/query it offline.

---

## Appendix C — Cost Model

Assumptions: B2 originals $6.95/TB-month; derivatives ~60 KB/item in B2;
local compute/disk already owned; AWS portion $0 by default.

| Line item | 100k items / 1 TB | 1M items / 10 TB | 10M items / 100 TB |
|---|---:|---:|---:|
| B2 originals | $6.95 | $69.50 | $695.00 |
| B2 derivatives (if mirrored) | $0.04 | $0.42 | $4.17 |
| Home server (power/disk, already paid) | — | — | — |
| Caddy / Node / SQLite | $0 | $0 | $0 |
| **Total (approx.)** | **~$7.00** | **~$70** | **~$699** |

Notes:

- Storage dominates. Optimize bytes (dedupe, derivative sizes, lifecycle), not
  compute.
- B2 egress is free up to 3× average stored per month, then $0.01/GB. Heavy
  video viewing across many friends could exceed that; a Bandwidth Alliance CDN
  (Cloudflare, bunny.net, Fastly) makes B2 egress free.
- Local SSD is the real hidden cost: at 10M items, thumbnails alone are ~600 GB.
  Decide derivative storage explicitly.
- Compare: 10 TB of originals in S3 Standard is ~$230/mo before egress; B2 at
  ~$70/mo for always-hot data is the right trade-off.

---

## Appendix D — Glossary

- **Derivative**: any generated artifact (thumbnail, preview, poster, proxy).
- **Serving index**: the local SQLite FTS5 database the API reads.
- **Lake**: durable Parquet datasets (local or S3), used for analytics.
- **Tombstone**: a row marking an item deleted, keeping history.
- **Keyset pagination**: paging by `(taken_at, id)` cursor instead of `OFFSET`.
- **Inverted index**: token → row-id map; what makes `MATCH` fast.
- **Bandwidth Alliance**: CDN partners that peer with Backblaze, making B2
  egress free.
- **Partition projection**: Athena derives partition locations from table
  properties instead of the catalog.

---

## Appendix E — Sources (verify before committing)

- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
- Backblaze transaction pricing: https://www.backblaze.com/cloud-storage/transaction-pricing
- B2 Event Notifications reference: https://www.backblaze.com/docs/cloud-storage-event-notifications-reference-guide
- SQLite FTS5: https://sqlite.org/fts5.html
- SQLite limits: https://sqlite.org/limits.html
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- Caddy reverse_proxy / file_server / basic_auth: https://caddyserver.com/docs/
- AWS Athena pricing: https://aws.amazon.com/athena/pricing/
- Athena partition projection: https://docs.aws.amazon.com/athena/latest/ug/partition-projection.html
- Amazon S3 pricing: https://aws.amazon.com/s3/pricing/
- Amazon CloudFront pricing: https://aws.amazon.com/cloudfront/pricing/
- AWS Lambda pricing: https://aws.amazon.com/lambda/pricing/
