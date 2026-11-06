# Plan: Scaling `b2-indexer` into a Self-Hosted Photo/Media Library

**Status:** Draft for review
**Date:** 2026-11-06
**Author:** Maintainers
**Scope:** Architecture, cost model, and phased implementation. No code in this document.

---

## 0. TL;DR

The goal is a self-hosted Google Photos: media lives in a Backblaze B2 bucket you
own, AWS indexes it, and a web app lets you browse/search it cheaply at terabyte
scale.

**Verdict on the proposed architecture:** the direction is right, but the
proposed pipeline is over-built in the wrong places and under-built in others.

- ✅ **Right:** B2 owns the bytes, Parquet on S3 is the queryable metadata lake,
  Athena for ad-hoc SQL.
- ⚠️ **Change:** drop **Firehose**. You do not have a streaming firehose; a
  scheduled/triggered batch writer that emits Parquet directly is cheaper and
  simpler than Firehose + format conversion.
- ⚠️ **Change:** Athena should **not** be the photo app's hot query path.
  Athena has multi-second latency, no full-text/fuzzy search, and needs Glue
  catalog management. Keep it for analytics/ad-hoc, but serve the UI from a
  compact **SQLite FTS5 serving index** (sharded as it grows).
- ❌ **Fix:** "static website in S3 with basic auth" does not exist. S3 static
  website hosting is public, HTTP-only, and has no auth primitive. You need
  CloudFront + an auth function (or Cognito/Cloudflare Access) in front of a
  private bucket.
- ❌ **Fix:** never serve media through AWS. Original bytes and thumbnails
  should be delivered from B2 (free egress up to 3× stored) or a CDN partner
  with free B2 egress. AWS egress at ~$0.09/GB is the one decision that can
  destroy the cost model.
- ➕ **Add:** an ingestion story. The current proposal has no defined source of
  events. Use B2 Event Notifications → webhook → queue → worker, plus a
  scheduled reconciliation pass (events are at-least-once and can be missed).
- ➕ **Add:** EXIF/ffprobe metadata extraction (capture date, GPS, camera,
  dimensions, duration), stable IDs, dedupe, and thumbnails for images, video
  poster frames, and audio art.

**Recommended shape:** *B2 = media origin, AWS = metadata control plane,
SQLite/DuckDB = serving index, CloudFront = edge/auth.* At rest, cost is
dominated by B2 storage (~$7/TB/month); the AWS control plane is roughly
**$0–25/month** even at 10M objects / 100TB, if you avoid the usual serverless
traps (NAT Gateway, Firehose, Glue crawlers, OpenSearch, and S3 egress).

---

## 1. Goals, Constraints, Non-Goals

### Goals

1. **Browse and search** a B2 bucket containing images, video, and audio.
2. **Cheap at rest**: terabytes of media should cost storage rates, not compute
   or egress rates.
3. **Cheap when idle**: no always-on database/cluster for a personal library.
4. **Scalable**: from 10k to ~10M objects without re-architecting.
5. **Own your data**: media stays in B2; metadata is exportable (Parquet/SQLite)
   and not locked into a proprietary service.
6. **Good UX**: timeline, albums, date filters, keyword search, thumbnails,
   video playback, downloads.
7. **Secure by default**: private buckets, least-privilege keys, authenticated
   app.

### Constraints

- B2 is the system of record for bytes. Do not duplicate originals into S3.
- AWS list prices only; no enterprise discounts.
- Prefer serverless/usage-based services; avoid fixed monthly minimums.
- Existing repo is CommonJS Node.js with a CLI pipeline and `dist/` output.
- Media may include formats browsers cannot play natively (HEVC/MOV); handle
  gracefully, do not assume transcoding.

### Non-Goals (for v1)

- Multi-tenant SaaS.
- Real-time collaborative editing.
- Automatic ML face clustering / semantic search (design a hook, defer).
- Video transcoding of the entire library (expensive; opt-in proxies only).
- Perfect real-time consistency. Minutes-level eventual consistency is fine.

---

## 2. Where the Codebase Is Today

Current pipeline (`index.js` → `thumbs.js` → `download_links.js` →
`generate_albums.js` → `generate_site*.js`) is a good prototype with these
scaling limits:

| Area | Current behavior | Problem at scale |
|---|---|---|
| Listing | `b2.listFileNames` full scan into `dist/index.jsonl` | Full rescan every run; no watermark; slow on millions of objects |
| Thumbnails | Downloads each original, resizes with `sharp`/`ffmpeg` locally | Single machine, concurrency 5; CPU/IO bound; no incremental tracking |
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

## 3. Review of the Proposed Architecture

Proposed:

```
[indexer] → Firehose → S3 raw → Parquet (year/month/day)
  → Glue Data Catalog → Athena → S3 static site (basic auth)
```

### What is correct

- **Parquet on S3 as the queryable metadata store.** Cheap, portable, good
  compression, columnar scans, works with Athena/DuckDB/Spark.
- **Glue + Athena for ad-hoc SQL.** Excellent for "how many videos per year",
  exports, and rebuilding derived data.
- **Static front end.** Cheap, cacheable, no server to patch.

### What is wrong or risky

| Issue | Why it matters | Recommended fix |
|---|---|---|
| **Firehose has no producer** | Firehose needs a stream; nothing described feeds it. Firehose also bills per GB ingested + format conversion and is designed for streaming, not a nightly batch. | Write Parquet directly from the indexer (or DuckDB/pyarrow job). Use Firehose only if ingest exceeds GB/hour sustained. |
| **Athena as the app's query engine** | 1–5s+ latency, per-query cold start, no full-text/fuzzy search, 20-query DML concurrency default, and every keystroke would scan S3. | Build a **serving index** (SQLite FTS5 or DuckDB) refreshed from Parquet. Athena is for analytics. |
| **"S3 static website + basic auth"** | S3 website endpoints are public and HTTP-only. There is no basic-auth feature. | Private S3 + CloudFront + CloudFront Function/Lambda@Edge auth, or Cognito, or Cloudflare Access. |
| **Media served from AWS** | S3/CloudFront egress is ~$0.085–0.09/GB. A few hundred GB of video traffic can cost more than the entire B2 bill. | Serve originals and thumbnails from B2 (free egress up to 3× stored; $0.01/GB beyond) or a B2 Bandwidth Alliance CDN. |
| **Date partitioning by upload day** | Photos are browsed by **capture** date, which may differ from upload date by years (imports, old drives). `year/month/day` by upload creates tiny partitions and wrong timeline buckets. | Partition the raw lake by ingest date; compact a derived catalog by **capture month**. Or partition by capture month and accept periodic rewrites. |
| **No state / no incremental** | Re-listing and re-downloading everything is the dominant cost at TB scale. | Durable per-object state (SQLite/DynamoDB), `fileId` + `uploadTimestamp` watermarks, and event notifications. |
| **No dedupe** | The same 4K clip uploaded twice doubles storage and confuses the timeline. | `contentSha1` exact dedupe (free from B2 listing) + optional perceptual hash for near-dupes. |
| **Queries scan too much** | Partitioning alone does not prune without partition projection or predicate pushdown. | Athena partition projection; DuckDB/Parquet row-group stats; sort within files by capture time. |
| **No auth on API / presigned URLs** | Pre-generated global tokens leak access to the whole bucket. | Per-request short-TTL presigned URLs, or a redirect endpoint. |

### One more trap: derived files re-triggering ingestion

If thumbnails/derived artifacts are written into the **same** B2 bucket, and
the event rule prefix is `""`, every thumbnail upload fires another event →
infinite loop. Put derived artifacts in a **separate bucket** or under a
reserved prefix (`_derived/`, `_index/`) that is excluded from both the event
rule and the indexer. The current `EXCLUDE_PATHS` is the right instinct; make it
mandatory and non-configurable for reserved prefixes.

---

## 4. Recommended Architecture

### 4.1 Design principles

1. **Separate the planes.**
   - **Media plane** (huge): B2 originals + derivatives. Never through AWS.
   - **Metadata plane** (small): S3 Parquet + serving index.
   - **Control plane** (tiny): ingestion, auth, API, monitoring.
2. **Download once, derive once.** Convert each original once; never re-read
   originals for serving.
3. **Append-only raw + compacted derived.** Raw ingest is immutable; the
   serving catalog is rebuilt/compacted on a schedule.
4. **The app never queries the lake directly.** It queries a small, fast
   serving index built from the lake.
5. **Everything idempotent.** Events are at-least-once; workers must upsert by
   a stable key.
6. **Two-tier realism.** Start static and serverless-cheap; add a database only
   when a measured threshold is crossed.

### 4.2 Target diagram

```
 ┌──────────────────────────── Backblaze B2 (private) ────────────────────────────┐
 │  media/…                      originals (images / video / audio)               │
 │  _derived/thumbs/…            generated thumbnails + posters                   │
 │  _derived/previews/…          optional larger previews / proxies               │
 └───────────────┬───────────────────────────────────────────┬────────────────────┘
                 │ B2 Event Notifications (HTTPS webhook)     │ S3-compatible GET
                 │ (ObjectCreated / Deleted / HideMarker)     │ (free egress ≤3×)
                 ▼                                            │
 ┌────────────── AWS Ingestion ──────────────┐                │
 │ API Gateway ─► webhook Lambda             │                │
 │   verify HMAC, return 200 < 3s            │                │
 │   ─► SQS (buffer + retries + DLQ)         │                │
 │   ─► Worker (Lambda container / Fargate)  │                │
 │        ffprobe / exiftool / sharp         │                │
 │        write thumbnail → B2 _derived/     │                │
 │        write metadata row → S3 Parquet    │                │
 │        upsert state (DynamoDB or SQLite)  │                │
 └───────────────┬───────────────────────────┘                │
                 │                                            │
                 ▼                                            │
 ┌──────────── AWS Metadata Lake ────────────┐                │
 │ s3://…/raw/ingest_date=YYYY-MM-DD/        │                │
 │        *.parquet  (append-only)           │                │
 │ s3://…/catalog/year=YYYY/month=MM/        │                │
 │        *.parquet  (compacted, derivable)  │                │
 │ s3://…/serving/catalog-YYYY.db (SQLite)   │                │
 └───────┬───────────────────────┬───────────┘                │
         │                       │                            │
         ▼                       ▼                            │
  Athena + Glue            Search API (Lambda)                │
  (ad-hoc / analytics)     reads serving DB, keyset paging    │
         │                       │                            │
         └───────────┬───────────┘                            │
                     ▼                                        │
          CloudFront (SPA + API + auth)  ──────►  Browser SPA │
                     │                                        │
                     └──── 302 / presigned URL ───────────────┘
```

### 4.3 B2 layout and keys

Use **two buckets** (preferred) or one bucket with a reserved prefix:

```
<bucket>/
  media/2024/2024-07-…            # originals (user uploads)
  _derived/thumbs/…               # 256px webp/avif grid
  _derived/previews/…             # 1024–1600px webp lightbox
  _derived/posters/…              # video poster frames
  _derived/audio-art/…            # audio cover art / waveform
```

- Reserved prefixes (`_derived/`, `_index/`) are **excluded** from event rules
  and from the indexer.
- Application keys, least privilege:
  - `indexer-ro`: list + download (Class B/C), no write.
  - `deriver-wo`: write only under `_derived/`.
  - `app-ro`: download authorization / presign only.
- Private bucket. If a public gallery mode is ever wanted, use a separate
  bucket and explicit lifecycle, never the same key.
- Consider B2 Object Lock / versioning only if accidental-delete protection is
  desired; versioning increases listing complexity.

### 4.4 Ingestion pipeline

**Primary: event-driven**

1. B2 Event Notification rule (requires Backblaze support to enable the
   feature) on `b2:ObjectCreated:*`, `b2:ObjectDeleted:*`,
   `b2:HideMarkerCreated:*`, prefix `media/`, with an HMAC signing secret.
2. Webhook = API Gateway → Lambda. It must:
   - verify `X-Bz-Event-Notification-Signature` (HMAC-SHA256, `v1=`),
   - drop duplicate `eventId`s,
   - enqueue the raw event to SQS,
   - return `200` within 3 seconds (B2 retries otherwise).
3. SQS → worker. Worker does the heavy work (ffprobe/exiftool/sharp can exceed
   API Gateway limits), with a DLQ and max receive count.
4. Worker writes:
   - metadata row → Parquet batch on S3,
   - thumbnail → B2 `_derived/`,
   - state/watermark → DynamoDB or SQLite (see 4.6),
   - sets `indexed_at` / `updated_at`.

**Fallback: reconciliation (mandatory)**

Events are at-least-once, can be missed, and B2 can suspend a rule. Run a
scheduled job (daily) that lists the bucket via the S3-compatible API and diffs
against the state store:

- present in B2, absent from index → enqueue create;
- present in index, absent from B2 → mark deleted (tombstone);
- `fileId`/`contentSha1`/size changed → re-derive.

B2 listing (`ListObjectsV2` / `b2_list_file_names`) is free (Class C), so a
daily full list is acceptable even at millions of objects, though you should
paginate efficiently and store a continuation token.

**Alternative if Event Notifications are not enabled:** run the
reconciliation diff on a schedule (e.g., hourly/nightly) and treat it as the
only ingest path. Simpler, slightly less real-time.

### 4.5 Metadata lake (S3 + Parquet)

Two datasets:

| Dataset | Layout | Purpose |
|---|---|---|
| **Raw** | `raw/ingest_date=YYYY-MM-DD/<batch>.parquet` | Immutable event log. Replayable. |
| **Catalog** | `catalog/year=YYYY/month=MM/media_type=…/<part>.parquet` | Compacted, deduped, sorted by `taken_at`; fastest for browse-by-date. |

Rules:

- Target **128–512 MB Parquet files**. Many tiny files kill Athena and inflate
  S3 request costs. Compact daily.
- Sort rows within a file by `taken_at`; Parquet row-group min/max stats then
  prune date ranges.
- Snappy or Zstd compression.
- Hive-style partitions + **Athena partition projection** for `raw/`. This
  avoids Glue crawlers and registered partitions. Important: Glue Data Catalog
  bills per metadata object (table/partition), not per row — with partition
  projection you keep only one table object, so Glue stays effectively free
  even at 10M rows. Without projection, registering millions of partitions
  would be a real cost.
- Schema evolution: additive columns only; never rename/remove without a
  migration. Parquet readers tolerate missing columns.
- **Outgrow point:** if you need row-level updates/deletes and compaction gets
  painful, move the catalog to **Apache Iceberg** on S3 (Athena/Glue/Spark
  support). Iceberg gives ACID upserts, snapshots, and hidden partitioning, at
  the cost of maintenance (compaction, snapshot expiry). Not needed for v1.

### 4.6 Serving index and search API

This is the piece the proposed design is missing.

**Why not Athena directly in the UI**

- 1–5s+ per query, cold starts.
- No `FTS`/fuzzy/substring; `LIKE '%x%'` scans.
- Every keystroke becomes a billable scan.
- Query concurrency quotas and workgroup management.

**Recommended: a compact SQLite FTS5 database**

- Built from `catalog/` Parquet by a scheduled job (DuckDB or Node + SQLite).
- Tables: `items`, `albums`, `tags`, `items_fts` (FTS5 over filename, album,
  tags, OCR/transcript text).
- Size: roughly **0.5–1.5 KB/item**, so:
  - 100k items ≈ 100–150 MB,
  - 1M items ≈ 1–1.5 GB,
  - 3M items ≈ 3–4.5 GB.
- Store `serving/catalog-<version>.db` in S3. The API Lambda downloads it to
  `/tmp` on cold start, keyed by ETag/version, and reuses it while warm.
  Use a Lambda **container image** so `better-sqlite3`'s native binary matches
  the runtime, and raise ephemeral storage only if the DB is large.
- Alternatively use **DuckDB** in the Lambda and query Parquet directly with
  its `fts` extension. DuckDB avoids a separate build step but rebuilds the FTS
  index per cold start; SQLite is better for repeated low-latency reads.

**Sharding (before the DB gets too big)**

- Shard by `year` and/or `media_type`; the API loads the shard(s) a query
  needs. This keeps the hot DB small and cold starts fast.
- At **>~3–5M items**, or when multi-user concurrency matters, move to a
  managed store:
  - Postgres on a small VPS (cheapest, ~$6–12/mo) or Aurora Serverless v2
    (min ~0.5 ACU ≈ $44/mo — only if you want AWS-managed), or
  - OpenSearch Serverless / self-hosted Meilisearch for heavy full-text.
  Do not start here.

**API surface (API Gateway HTTP API + Lambda)**

```
GET /api/search?q=&from=&to=&album=&type=&tag=&sort=&cursor=
GET /api/timeline?year=&month=&cursor=
GET /api/albums
GET /api/items/{id}
GET /api/items/{id}/download   -> 302 to short-TTL B2 URL
GET /api/items/{id}/stream     -> 302 to short-TTL B2 URL (range-capable)
POST /api/items/presign        -> batch presign (bounded count)
```

- **Keyset pagination** on `(taken_at DESC, item_id)`; never `OFFSET` at scale.
- Cache album/timeline responses; cache the serving DB handle across invocations.
- Rate-limit at API Gateway; cap batch presign size.
- Return only metadata + thumbnail URL; fetch originals on demand.

**Auth**

- SPA on CloudFront: CloudFront Function (or Lambda@Edge) checking a signed
  session cookie or basic auth. Credentials in CloudFront KeyValueStore/Secrets
  Manager, not in source. For a single user this is enough.
- API: API Gateway authorizer — a shared bearer token from Secrets Manager for
  single-user, or a Cognito JWT authorizer for multiple users
  (Cognito free tier: 50k MAU).
- If you already use Cloudflare, **Cloudflare Access** in front of everything is
  the least-effort option (free for small teams) and also gives free B2 egress
  via the Bandwidth Alliance.
- Do **not** rely on S3 static website auth. It does not exist.

### 4.7 Media delivery

Priority order:

1. **B2 direct with short-TTL presigned URLs** (S3-compatible presign or B2
   download authorization). Cheapest, no AWS egress. B2 supports range
   requests, so video seeking works.
2. **B2 behind a Bandwidth Alliance CDN** (Cloudflare, bunny.net, Fastly) for
   unlimited free B2 egress if you expect heavy traffic.
3. **CloudFront in front of B2** only if you need AWS-native auth/WAF/logging.
   Note: CloudFront pulling from B2 still consumes B2 egress (free within 3×),
   and you lose B2's cache-friendly free path. Prefer direct/presigned unless
   you need CloudFront features.

Details:

- Presign TTL: 5–15 minutes, per request. Do not emit month-long tokens.
- For video, redirect (`302`) to B2 rather than proxying bytes through Lambda;
  proxying destroys cost and concurrency.
- Thumbnails are also private; presign them or serve via a short-TTL token. If
  you want CloudFront caching, use a Lambda@Edge/CloudFront Function that
  validates a session cookie and rewrites to a presigned origin URL — otherwise
  every unique signature busts the cache.
- Unsupported codecs: detect with `ffprobe`; optionally generate an H.264/AAC
  MP4 proxy in `_derived/` **on demand or on a schedule**, never for the whole
  library by default.

### 4.8 Web app

- SPA (React/Vue/Svelte) hosted on private S3 + CloudFront.
- Views: timeline (infinite scroll, grouped by month), albums, search, item
  detail/lightbox, video player, download.
- Thumbnails: lazy-loaded, `srcset` for grid vs preview, `loading="lazy"`,
  content-visibility for long timelines.
- Search: debounce 250–300ms; cancel in-flight requests; show skeletons.
- Offline/PWA optional.

### 4.9 Request flows

**Upload → visible**

```
user/rclone uploads to B2 media/…
  → B2 ObjectCreated event → webhook (200 in <3s) → SQS
  → worker: ffprobe/exif → thumbnail to B2 _derived/
  → metadata row to S3 raw/ Parquet
  → catalog compaction (daily) → serving DB rebuild (daily/on-demand)
  → SPA sees it on next catalog version (or optimistically via a "recent" index)
```

**Browse/search**

```
SPA → CloudFront (auth) → GET /api/timeline or /api/search
  → Lambda (serving DB in /tmp) → JSON (metadata + item ids)
  → browser requests thumbnails → presigned B2 URLs
  → user opens item → GET /api/items/{id}/stream → 302 → B2 (range)
```

**Delete/rename**

```
B2 ObjectDeleted/HideMarker event (or reconciliation diff)
  → worker writes tombstone to raw Parquet (deleted_at, event_id)
  → catalog compaction drops/updates the row
  → serving DB rebuild removes it
```

---

## 5. Data Model

One row per object version (latest version = current item). Stable keys matter.

| Column | Type | Notes |
|---|---|---|
| `item_id` | string | `sha1(bucket + ":" + fileId)` or B2 `fileId`; stable per version |
| `bucket` | string | source bucket |
| `object_key` | string | full B2 object name |
| `file_id` | string | B2 fileId (version-unique) |
| `version_id` | string | B2 version |
| `content_sha1` | string | exact dedupe key |
| `content_type` | string | from B2 or sniffed |
| `size_bytes` | int64 | |
| `media_type` | enum | `image` / `video` / `audio` / `other` |
| `uploaded_at` | timestamp | B2 upload timestamp |
| `taken_at` | timestamp | EXIF `DateTimeOriginal` / video creation_time / ID3; fallback `uploaded_at` |
| `taken_at_source` | enum | `exif` / `video` / `id3` / `filename` / `upload` |
| `album` | string | derived from first path segment |
| `path_segments` | list<string> | for folder browsing |
| `width`, `height` | int | |
| `duration_ms` | int64 | video/audio |
| `camera_make`, `camera_model`, `lens` | string | EXIF |
| `iso`, `f_number`, `exposure_time`, `focal_length` | double | EXIF |
| `gps_lat`, `gps_lon` | double | EXIF; consider privacy toggle |
| `orientation` | int | EXIF |
| `thumb_key`, `preview_key`, `poster_key` | string | B2 `_derived/` keys |
| `phash` | string | optional perceptual hash |
| `tags` | list<string> | user/auto |
| `ocr_text`, `transcript` | string | optional, lazy ML |
| `indexed_at`, `updated_at` | timestamp | |
| `deleted_at` | timestamp | tombstone |
| `event_id` | string | last event that produced this row |

**Dedupe:** exact = `content_sha1`; near-dupe = `phash` Hamming distance. Keep a
`duplicate_of` pointer rather than deleting, so storage can be reclaimed later.

---

## 6. Cost Model

List prices, USD, late 2026. Treat as planning estimates, not quotes; verify
before committing. Assumptions:

- Originals stay in **B2** at **$6.95/TB-month** (some B2 docs quote
  $0.005/GB ≈ $5/TB; use ~$7/TB to be safe).
- Derivatives: 2 thumbnails × ~30 KB = **60 KB/item**, in B2.
- Catalog Parquet: **~0.3 KB/item** in S3 Standard ($0.023/GB-month).
- Serving DB: **~1 KB/item**, stored in S3; loaded into Lambda `/tmp`.
- Athena **$5/TB scanned**, 10 MB minimum per query; ~2,000 searches/month.
  (Most searches should hit the serving index, so this is a generous ceiling.)
- Lambda free tier: 1M requests + 400k GB-s/month.
- API Gateway HTTP API: **$1.00/M requests**.
- CloudFront: **Free plan** ($0, 100 GB + 1M req/month) or **Pro plan** ($15,
  50 TB + 10M req/month). Pay-as-you-go is ~$0.085/GB; avoid unless you need it.
- Glue: effectively $0 with **partition projection** (one table object). Glue
  bills per catalog object, not per row.
- No NAT Gateway (keep Lambdas outside a VPC; S3/B2 over public endpoints).
- B2 egress: free up to 3× average stored per month, then $0.01/GB.

| Line item | 100k items / 1 TB | 1M items / 10 TB | 10M items / 100 TB |
|---|---:|---:|---:|
| B2 originals | $6.95 | $69.50 | $695.00 |
| B2 derivatives (60 KB/item) | $0.04 | $0.42 | $4.17 |
| S3 catalog Parquet | $0.001 | $0.007 | $0.07 |
| Glue (partition projection) | $0.00 | $0.00 | $0.00 |
| Athena (2k queries) | $0.20 | $0.50 | $2.00 |
| Lambda + API Gateway | $0.10 | $1.00 | $5.00 |
| CloudFront | $0 (Free) | $15 (Pro) | $15 (Pro) |
| **Total (approx.)** | **~$7.30** | **~$86** | **~$721** |
| **AWS/CDN portion only** | **~$0.30** | **~$16.50** | **~$22** |

**Takeaways**

- Storage dominates. Optimize bytes (dedupe, derivative sizes, lifecycle), not
  Lambda.
- The control plane is noise *if* you avoid: NAT Gateway (~$32+/mo + data),
  Firehose, OpenSearch (~$25+/mo minimum), Aurora Serverless (~$44+/mo minimum),
  Glue crawlers, and S3 media egress.
- **Comparison:** putting the same 10 TB of originals in S3 Standard is ~$230/mo
  before egress; S3 Deep Archive is ~$10/mo but unusable for browsing
  (hours to restore, retrieval fees). B2 at ~$70/mo for always-hot data is the
  right trade-off. S3 Glacier is for a *second* archival copy, not the app.
- **Cost guards:** AWS Budgets alerts; Athena workgroup per-query scan limit;
  S3 lifecycle to expire `raw/` after it is compacted (optional); CloudWatch
  billing alarm; no NAT; no idle databases.

---

## 7. Scaling Thresholds and Options

| Scale | Recommendation | Why |
|---|---|---|
| **≤ 100k items** | Fully static SPA + client-side search (SQLite-WASM / DuckDB-WASM over compact JSON/Parquet shards) + B2 presign. No API, no Lambda. | Cheapest, simplest, reuses current static approach. |
| **100k – 3M** | Static SPA + **Lambda search API over sharded SQLite FTS5**. Athena for analytics. | Fast search, cheap, no idle DB. |
| **3M – 10M** | Shard serving DB by year/album; or move to Postgres (small VPS) / Aurora Serverless v2. Consider Iceberg for the lake. | SQLite cold-load and rebuild time grows. |
| **> 10M / multi-user** | Managed Postgres + OpenSearch/Meilisearch; consider partitioning by user/tenant. | Full-text + concurrency + row-level updates. |

**When to add Athena to the UI:** almost never. Add an "advanced/export" page
that runs a bounded Athena query with a workgroup scan limit and caches results.
Label it as slow.

**When to add ML enrichment:** after the library is browsable. Face clustering,
OCR, labels, and transcripts are the Google-Photos "magic" but are optional,
embarrassingly parallel, and best batched. Keep them as a separate derived
dataset joined by `item_id`, so the core pipeline stays cheap and simple.

---

## 8. Alternatives Considered

| Option | Query latency | Idle cost | Ops | Verdict |
|---|---|---|---|---|
| **Static SPA + client search** | fast (local) | ~$0 | low | Best ≤100k; index download grows |
| **Lambda + sharded SQLite FTS5** (recommended) | ~50–300 ms | ~$0–5 | medium | Best 100k–3M; rebuild + cold-load |
| **Lambda + DuckDB over Parquet** | ~0.5–3 s | ~$0–5 | low-medium | No separate index build; slower FTS |
| **API + Athena** | 1–5 s+ | ~$0 | low | Good analytics; poor UX/bill at keystroke |
| **DynamoDB** | single-digit ms | ~$0.25/GB-mo + reads | low | Great key/value; weak full-text and date-range UX without GSIs |
| **OpenSearch / Meilisearch** | ms | $25+/mo or VPS | high | Only for heavy search / many users |
| **Aurora Serverless v2 / RDS** | ms | ~$44+/mo minimum | medium | Overkill solo; good multi-user |
| **VPS + Postgres + Meilisearch** | ms | ~$6–12/mo | medium | Cheapest "real DB"; not AWS-native |
| **Firehose + Parquet conversion** | n/a | per-GB | medium | Drop; batch is cheaper/simpler |

**Decision:** build the lake (Parquet + Athena) because it is portable and cheap
to keep forever, but serve the app from a SQLite/DuckDB serving index. This
gives Google-Photos-like UX without a Google-Photos-like bill.

---

## 9. Implementation Plan

Infrastructure as code: **AWS SAM** (simplest for Lambda/API/SQS) or **AWS CDK
TypeScript**. Keep it in `infra/`. Do not hand-build the stack in the console.

### Phase 0 — Foundations (1–2 days)

- [ ] Extract shared B2 logic into `lib/b2.js` (S3-compatible `ListObjectsV2`
      pagination, download stream, presign, key scoping). Keep the native B2
      client only for `downloadFileById` if convenient.
- [ ] Define stable IDs (`item_id = fileId`), dedupe keys (`contentSha1`), and
      reserved prefixes (`_derived/`, `_index/`).
- [ ] Add a state store: SQLite locally for the CLI; DynamoDB table
      (`item_id`, `etag`, `indexed_at`, `status`) for the cloud worker.
- [ ] Add `EXIF` extraction (`exiftool-vendored` or `sharp` metadata) and
      `ffprobe` parsing helpers in `lib/media.js`.
- [ ] Define the metadata schema in `lib/schema.js` and a version field.

**Acceptance:** a dry run indexes 1k objects, extracts metadata, and produces
valid rows without re-downloading unchanged objects.

### Phase 1 — Incremental index + Parquet lake (3–5 days)

- [ ] Replace the full `index.js` scan with an incremental diff against the
      state store (upload timestamp/fileId watermarks).
- [ ] Write append-only Parquet to `s3://…/raw/ingest_date=…/` in batches
      (Node `parquetjs-lite` or a DuckDB/pyarrow step).
- [ ] Add daily compaction → `s3://…/catalog/year=/month=/…` sorted by
      `taken_at`; target 128–512 MB files.
- [ ] Add Athena DDL with **partition projection**; document sample queries.
- [ ] Add `npm run backfill`, `npm run compact`, `npm run verify` scripts.

**Acceptance:** a 100k-object backfill produces a compacted catalog; Athena
returns timeline counts in <5s; no duplicate rows on re-run.

### Phase 2 — Derivatives (3–5 days)

- [ ] Split `thumbs.js` into `lib/derive.js`; add image grid + preview, video
      poster, audio art; write to B2 `_derived/`.
- [ ] Idempotent by `item_id` + derivative spec; skip if the derivative exists
      and the source hash matches.
- [ ] Concurrency via `p-limit`; for large backfills, run as an ECS Fargate/
      Batch job (spot) or on the home server, not a single CLI process.
- [ ] Handle unsupported formats and corrupt files without failing the batch.

**Acceptance:** derivatives for 10k mixed items; re-run creates zero duplicates;
failures land in a retry list.

### Phase 3 — Event-driven ingestion (3–5 days)

- [ ] Enable B2 Event Notifications (support request) and create rules for
      `media/` create/delete/hide with an HMAC secret.
- [ ] Build API Gateway + webhook Lambda: verify signature, dedupe `eventId`,
      enqueue to SQS, return 200 <3s.
- [ ] Build SQS → worker (Lambda container image with `ffmpeg`/`sharp`/SQLite)
      with DLQ, partial batch failure, and idempotent upserts.
- [ ] Build the nightly reconciliation Lambda (S3-compatible list + diff).
- [ ] CloudWatch alarms: webhook 5xx, DLQ depth, reconciliation drift,
      derive failures.

**Acceptance:** upload a photo → it appears in the catalog within minutes;
delete it → it tombstones; kill the worker mid-batch → retries succeed; a
reconciliation run reports zero unexplained drift.

### Phase 4 — Serving index + API (5–8 days)

- [ ] `build_catalog.js`: Parquet → SQLite FTS5 (`items`, `albums`, `tags`,
      `items_fts`), sharded by year; upload `serving/catalog-<ver>.db`.
- [ ] Lambda container API: load DB from S3 by ETag, keyset pagination,
      `/search`, `/timeline`, `/albums`, `/items`, `/presign`, redirect endpoints.
- [ ] API Gateway HTTP API + authorizer; throttling; CORS.
- [ ] Presign B2 URLs (S3 SigV4 or B2 download authorization), short TTL.
- [ ] Contract tests with fixtures; load test at expected concurrency.

**Acceptance:** p95 `/search` < 300 ms warm, < 1.5 s cold; correct pagination;
no full-bucket scans per request; presigned URL expires and refreshes.

### Phase 5 — Web app + auth + edge (5–8 days)

- [ ] SPA with timeline, albums, search, lightbox, video, download.
- [ ] Private S3 + CloudFront (OAC); CloudFront Function/Lambda@Edge auth;
      or Cloudflare Access.
- [ ] Caching: hashed assets immutable; HTML short TTL; API no-store.
- [ ] Accessibility, keyboard nav, mobile layout, error/empty states.

**Acceptance:** authenticated browse on mobile and desktop; unauthenticated
requests get 401; thumbnails load lazily; video seeks via range requests.

### Phase 6 — Optional / later

- [ ] Athena saved queries / admin dashboard.
- [ ] ML enrichment: Rekognition labels/faces, OCR, transcripts (batch, opt-in).
- [ ] Iceberg migration if row-level updates become painful.
- [ ] Duplicate reclamation (delete `duplicate_of` originals after review).
- [ ] On-demand H.264 proxy generation for unsupported codecs.

### Repo changes summary

| Current | Fate |
|---|---|
| `index.js` | Rewrite as incremental backfill/reconcile; move logic to `lib/b2.js` |
| `thumbs.js` | Split into `lib/derive.js`; keep CLI wrapper for local runs |
| `download_links.js` | Replace with per-request presign in the API; keep a CLI for exports |
| `generate_albums.js` | Fold into catalog build (albums are a query, not a file) |
| `generate_site.js` / `generate_site_albums.js` | Keep as a static fallback/exporter; primary UI becomes the SPA |
| `lib/common.js` | Split into `lib/config.js`, `lib/b2.js`, `lib/media.js`, `lib/schema.js` |
| `dist/` | Becomes local build output only; canonical data is S3 + B2 |

---

## 10. Operations Runbook

**Daily**

- Reconciliation diff; report drift (should be 0).
- Compaction if new raw batches exist; rebuild serving DB if catalog changed.
- Check DLQ depth, derive failure count, webhook error rate.

**Weekly**

- Verify a sample of presigned downloads and thumbnail renders.
- Check B2 storage growth vs. dedupe ratio.
- Review AWS Cost Explorer for surprise line items (NAT, egress, Athena scans).

**On failure**

| Symptom | Likely cause | Action |
|---|---|---|
| New uploads not appearing | Event rule suspended / webhook 5xx | Check B2 rule status + CloudWatch; run reconciliation |
| Duplicate timeline entries | Replay not idempotent | Dedupe by `item_id`/`event_id`; rebuild catalog |
| Thumbnails missing | Worker timeout on large video | Increase memory/timeout; use Fargate for big files |
| Search stale | Serving DB not rebuilt | Trigger catalog build; verify version/ETag |
| Bill spike | Egress or Athena scan | Check CloudFront/S3 egress; set workgroup scan limit |
| Presigned 403 | Clock skew / key scope | Verify key capabilities and TTL |

**Disaster recovery**

- Metadata is derivable from B2 by full re-list (free Class C) + re-derive.
  Keep the Parquet lake as a fast rebuild source.
- Keep B2 application keys in a password manager/Secrets Manager.
- Export `catalog.db` periodically for offline use.
- Document the "rebuild from scratch" path: list → derive → compact → serve.

---

## 11. Security and Privacy

- **Buckets private.** No public ACLs. Presigned URLs only.
- **Least-privilege B2 keys**, scoped by bucket and capability; rotate.
- **Webhook hardening:** HMAC verification, timestamp/replay window,
  constant-time compare, SQS buffer, API Gateway throttling/WAF.
- **Auth:** CloudFront Function/signed cookie or Cloudflare Access for the SPA;
  Cognito/JWT or bearer token for the API. No shared long-lived download tokens.
- **Secrets:** Secrets Manager/SSM; never commit `.env`; never put secrets in
  Lambda env plaintext or client code.
- **Encryption:** TLS everywhere; B2 SSE-B2 and S3 SSE-S3 at rest.
- **PII:** EXIF GPS is sensitive. Default to hiding precise GPS in the UI; expose
  a coarse location only on explicit request.
- **Abuse:** rate-limit search and presign; cap batch sizes; monitor egress.
- **Audit:** CloudTrail for AWS; B2 event logs for object changes.

---

## 12. Risks and Open Questions

| Risk | Impact | Mitigation |
|---|---|---|
| B2 Event Notifications require support enablement and can be suspended | Missed ingests | Reconciliation is mandatory, not optional |
| Webhook 3s timeout | Lost events if handler is slow | Enqueue only; do work async |
| At-least-once delivery | Duplicates | Idempotent upserts by `item_id`/`eventId` |
| Lambda 15-min limit | Large video processing fails | Fargate/Batch for files above a threshold |
| SQLite cold-load at millions of rows | Slow first request | Shard by year/album; target <1–2 GB per shard |
| Parquet small-file proliferation | Athena slow/costly | Daily compaction, 128–512 MB targets |
| B2 3× egress cap | Overage $0.01/GB | Monitor; use a Bandwidth Alliance CDN for heavy video |
| Format/codec diversity | Broken playback | Detect, show download fallback, optional proxies |
| Scope creep into ML | Cost/time sink | Phase 6, optional, separate pipeline |
| Athena/Glue misuse | Surprise bills | Partition projection, scan limits, no per-keystroke queries |

**Open questions for the maintainer**

1. **Expected object count and mix** (photos vs. video vs. audio)? This decides
   whether SQLite is enough or a DB is needed sooner.
2. **Single user or family/multi-user?** Affects auth choice (shared token vs.
   Cognito) and concurrency.
3. **Is B2 already populated, or is this a new bucket?** Determines backfill
   strategy and whether `contentSha1` dedupe is available.
4. **How important is instant search vs. "search on submit"?** Athena-only is
   viable if 2–3s is acceptable.
5. **Are event notifications enabled on the B2 account?** If not, start with
   scheduled reconciliation.
6. **Do you want to keep the current static HTML output** as an offline/export
   mode, or replace it entirely?
7. **Is transcoding required** for your video formats, or is download fallback
   acceptable?

---

## 13. Appendix

### A. Athena table sketch (partition projection)

```sql
CREATE EXTERNAL TABLE catalog (
  item_id string, bucket string, object_key string, file_id string,
  content_sha1 string, content_type string, size_bytes bigint,
  media_type string, uploaded_at timestamp, taken_at timestamp,
  width int, height int, duration_ms bigint,
  camera_make string, camera_model string,
  gps_lat double, gps_lon double,
  album string, thumb_key string, preview_key string, poster_key string,
  indexed_at timestamp, deleted_at timestamp
)
PARTITIONED BY (year string, month string)
STORED AS PARQUET
LOCATION 's3://<meta-bucket>/catalog/'
TBLPROPERTIES (
  'projection.enabled' = 'true',
  'projection.year.type' = 'integer',
  'projection.year.range' = '1990,2035',
  'projection.month.type' = 'integer',
  'projection.month.range' = '1,12',
  'projection.month.digits' = '2',
  'storage.location.template' = 's3://<meta-bucket>/catalog/year=${year}/month=${month}/'
);
```

### B. Serving DB sketch

```sql
CREATE TABLE items (
  item_id TEXT PRIMARY KEY, object_key TEXT, media_type TEXT,
  taken_at INTEGER, uploaded_at INTEGER, album TEXT,
  width INTEGER, height INTEGER, duration_ms INTEGER,
  thumb_key TEXT, preview_key TEXT, poster_key TEXT,
  size_bytes INTEGER, content_sha1 TEXT, deleted_at INTEGER
);
CREATE VIRTUAL TABLE items_fts USING fts5(
  object_key, album, tags, ocr_text, transcript,
  content='items', content_rowid='rowid'
);
CREATE INDEX items_timeline ON items(taken_at DESC, item_id);
CREATE INDEX items_album ON items(album, taken_at DESC);
```

### C. Pricing sources (verify before committing)

- Backblaze B2: https://www.backblaze.com/cloud-storage/pricing ($6.95/TB-mo,
  free egress ≤3×, $0.01/GB beyond).
- Backblaze transactions: https://www.backblaze.com/cloud-storage/transaction-pricing
  (Class A/B/C free; Class D event notifications first 2,500/day free, then
  $0.004/10k).
- B2 Event Notifications: https://www.backblaze.com/docs/cloud-storage-event-notifications-reference-guide
  (webhook only, HTTPS, 3s timeout, at-least-once, HMAC optional, feature
  requires support enablement).
- Amazon Athena: https://aws.amazon.com/athena/pricing/ ($5/TB scanned, 10 MB
  minimum per query).
- Athena partition projection: https://docs.aws.amazon.com/athena/latest/ug/partition-projection.html
- AWS Lambda: https://aws.amazon.com/lambda/pricing/ (1M req + 400k GB-s free).
- Amazon CloudFront: https://aws.amazon.com/cloudfront/pricing/ (flat-rate
  plans: Free / Pro $15 / Business $200; pay-as-you-go also available).
- Amazon S3: https://aws.amazon.com/s3/pricing/ (Standard $0.023/GB-mo;
  Glacier IR ~$0.004/GB-mo; Deep Archive ~$0.00099/GB-mo + retrieval).
- AWS Glue: https://aws.amazon.com/glue/pricing/ (Data Catalog billed per
  object/partition; partition projection avoids per-partition cost).

### D. Glossary

- **Derivative**: any generated artifact (thumbnail, preview, poster, proxy).
- **Serving index**: the small, fast database the API reads (SQLite FTS5).
- **Lake**: the durable Parquet datasets on S3.
- **Tombstone**: a row marking an item deleted, keeping history.
- **Partition projection**: Athena derives partition locations from table
  properties instead of the Glue catalog.
- **Bandwidth Alliance**: CDN partners that peer with Backblaze so B2 egress is
  free.
