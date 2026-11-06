'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const sharp = require('sharp');
const {
    THUMBS_DIR,
    INDEX_PATH,
    createB2Client,
    ensureDir,
    fileExists,
    envInt,
    envBool,
    extname,
    isImage,
    isVideo,
    readJsonl,
    thumbKey,
    downloadUrl
} = require('./lib/common');

const execFileAsync = promisify(execFile);

const CONCURRENCY = envInt('THUMBNAIL_CONCURRENCY', 5, { min: 1, max: 32 });
const RESIZE_THRESHOLD = envInt('THUMBNAIL_MIN_BYTES', 500000, { min: 0 });
const MAX_DIMENSION = envInt('THUMBNAIL_MAX_DIMENSION', 500, { min: 16 });
const JPEG_QUALITY = envInt('THUMBNAIL_QUALITY', 80, { min: 1, max: 100 });
const VIDEO_SEEK_SECONDS = envInt('VIDEO_SEEK_SECONDS', 5, { min: 0 });
const VERBOSE = envBool('VERBOSE', false);
const PROGRESS_EVERY = envInt('PROGRESS_EVERY', 100, { min: 1 });

const SHARP_FORMATS = {
    '.jpg': 'jpeg',
    '.jpeg': 'jpeg',
    '.png': 'png',
    '.webp': 'webp',
    '.avif': 'avif',
    '.tif': 'tiff',
    '.tiff': 'tiff',
    '.gif': 'gif'
};

async function run() {
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(CONCURRENCY);

    await ensureDir(THUMBS_DIR);

    const b2 = createB2Client();
    const response = await b2.authorize();
    const auth = {
        apiUrl: response.data.apiUrl,
        bucketName: response.data.allowed.bucketName,
        authorizationToken: response.data.authorizationToken
    };

    const ctx = { b2, auth, seen: new Set() };
    const stats = { created: 0, skipped: 0, failed: 0, total: 0 };
    const pending = new Set();

    for await (const entry of readJsonl(INDEX_PATH)) {
        const task = limit(async () => {
            try {
                const status = await processEntry(entry, ctx);
                stats[status] += 1;
            } catch (err) {
                stats.failed += 1;
                console.error(`failed: ${entry.filename}: ${err.message}`);
            }

            stats.total += 1;
            if (VERBOSE) {
                console.log(`processed: ${entry.filename}`);
            } else if (stats.total % PROGRESS_EVERY === 0) {
                console.log(`processed ${stats.total} files...`);
            }
        });

        const tracked = task.finally(() => pending.delete(tracked));
        pending.add(tracked);

        if (pending.size >= CONCURRENCY * 2) {
            await Promise.race(pending);
        }
    }

    await Promise.allSettled(pending);

    console.log(
        `Done. ${stats.created} created, ${stats.skipped} skipped, ${stats.failed} failed (${stats.total} total).`
    );
}

async function processEntry(entry, ctx) {
    if (!isImage(entry.filename) && !isVideo(entry.filename)) {
        return 'skipped';
    }

    const dest = path.join(THUMBS_DIR, thumbnailName(entry));

    if (ctx.seen.has(dest)) {
        console.warn(`duplicate thumbnail name, skipping: ${entry.filename}`);
        return 'skipped';
    }
    ctx.seen.add(dest);

    if (await fileExists(dest)) {
        return 'skipped';
    }

    if (isImage(entry.filename)) {
        await processImage(entry, dest, ctx.b2);
    } else {
        await processVideo(entry, dest, ctx.auth);
    }

    return 'created';
}

function thumbnailName(entry) {
    const key = thumbKey(entry.filename);
    return isVideo(entry.filename) ? `${key}-thumb.jpg` : key;
}

async function processImage(entry, dest, b2) {
    const response = await b2.downloadFileById({
        fileId: entry.fileId,
        responseType: 'stream'
    });
    const tmpPath = `${dest}.tmp`;

    try {
        if (Number(entry.contentLength) > RESIZE_THRESHOLD) {
            await writeResized(response.data, tmpPath, entry.filename);
        } else {
            await pipeline(response.data, fs.createWriteStream(tmpPath));
        }
        await fsp.rename(tmpPath, dest);
    } catch (err) {
        await fsp.rm(tmpPath, { force: true });
        throw err;
    }
}

async function writeResized(input, outputPath, filename) {
    const format = SHARP_FORMATS[extname(filename)];

    if (!format) {
        const chunks = [];
        for await (const chunk of input) {
            chunks.push(chunk);
        }
        const buffer = await sharp(Buffer.concat(chunks))
            .rotate()
            .resize(resizeOptions())
            .toBuffer();
        await fsp.writeFile(outputPath, buffer);
        return;
    }

    const transform = sharp()
        .rotate()
        .resize(resizeOptions());

    transform.toFormat(format, format === 'jpeg' ? { quality: JPEG_QUALITY } : {});

    await pipeline(input, transform, fs.createWriteStream(outputPath));
}

function resizeOptions() {
    return {
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true
    };
}

async function processVideo(entry, dest, auth) {
    const videoUrl = downloadUrl(
        auth.apiUrl,
        auth.bucketName,
        entry.filename,
        auth.authorizationToken
    );
    const tmpPath = `${dest}.tmp.jpg`;
    const args = [
        '-loglevel', 'error',
        '-ss', String(VIDEO_SEEK_SECONDS),
        '-i', videoUrl,
        '-frames:v', '1',
        '-q:v', '2',
        '-update', '1',
        '-y',
        tmpPath
    ];

    try {
        await execFileAsync('ffmpeg', args);
        await fsp.rename(tmpPath, dest);
    } catch (err) {
        await fsp.rm(tmpPath, { force: true });
        throw err;
    }
}

run().catch((err) => {
    console.error(err.stack || err);
    process.exitCode = 1;
});
