# AGENTS.md

## Project

`b2-indexer` is a small Node.js CLI toolkit that reads a Backblaze B2 bucket and
generates a static photo gallery. There is no build step, framework, test suite,
or linter. Each script is a standalone entry point executed with `node`.

## Language & conventions

- CommonJS (`require`), no TypeScript, no transpilation.
- 4-space indentation, single quotes, semicolons are inconsistent per file —
  match the surrounding file.
- Entry scripts are named with underscores (`generate_site.js`); package script
  names use dashes (`generate-site`).
- All paths are built from `__dirname`; everything reads/writes under `dist/`.
- Config comes from `.env` (see `.env.example`); never hardcode credentials.

## Commands

```bash
npm install                 # install dependencies (Node >= 20.9.0)
npm run index               # dist/index.jsonl — bucket listing
npm run thumbs              # dist/thumbs/ — image + video thumbnails
npm run generate-links      # dist/download-links.json
npm run generate-albums     # dist/albums.json
npm run generate-site       # dist/page*.html, all-index.html
npm run generate-site-albums# dist/albums-page*.html, index.html
```

`npm test` is a placeholder and always fails. There is no lint/typecheck script.

## Pipeline order

1. `index.js` — paginates `b2.listFileNames`, writes JSONL. Honors
   `EXCLUDE_PATHS` (comma-separated prefixes).
2. `thumbs.js` — streams `index.jsonl`, resizes images >500 KB with `sharp`,
   pulls a video frame with `ffmpeg` (must be installed on the host).
3. `download_links.js` — builds presigned/authorized URLs into a JSON map.
4. `generate_albums.js` — groups files by first path segment into `albums.json`.
5. `generate_site.js` / `generate_site_albums.js` — emit static HTML.

Steps 1 and 2 are the ones run frequently; the rest are occasional.

## External requirements

- `ffmpeg` on `PATH` for video thumbnails (`brew install ffmpeg` on macOS).
- B2 credentials in `.env`: `APPLICATION_KEY_ID`, `APPLICATION_KEY`,
  `BUCKET_ID`, plus `IMAGE_EXTENSIONS` / `VIDEO_EXTENSIONS` (comma-separated,
  no dots).

## Gotchas

- `dist/thumbs/` must exist before `generate_site*.js` reads it; generated
  output is gitignored.
- Thumbnail filenames flatten `/` to `_`, so collisions are possible across
  folders.
- `thumbs.js` skips already-existing thumbnails, but video thumbnails reject
  on skip; the error is caught and logged.
- `dotenv` is called with `{ quiet: true }` to suppress v17+ banner output.
- `p-limit` is ESM-only and is loaded via dynamic `import()` inside `run()`.
