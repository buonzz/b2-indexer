'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

require('dotenv').config({
    path: path.join(__dirname, '..', '.env'),
    quiet: true
});

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const THUMBS_DIR = path.join(DIST_DIR, 'thumbs');
const INDEX_PATH = path.join(DIST_DIR, 'index.jsonl');
const ALBUMS_PATH = path.join(DIST_DIR, 'albums.json');
const LINKS_PATH = path.join(DIST_DIR, 'download-links.json');

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function envInt(name, fallback, { min = -Infinity, max = Infinity } = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
}

function envBool(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    return /^(1|true|yes|on)$/i.test(raw);
}

function parseExtensions(value) {
    return (value || '')
        .split(',')
        .map((ext) => ext.trim().toLowerCase())
        .filter(Boolean)
        .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
}

const IMAGE_EXTENSIONS = new Set(parseExtensions(process.env.IMAGE_EXTENSIONS));
const VIDEO_EXTENSIONS = new Set(parseExtensions(process.env.VIDEO_EXTENSIONS));

function extname(filename) {
    return path.extname(filename).toLowerCase();
}

function isImage(filename) {
    return IMAGE_EXTENSIONS.has(extname(filename));
}

function isVideo(filename) {
    return VIDEO_EXTENSIONS.has(extname(filename));
}

function createB2Client() {
    const B2 = require('backblaze-b2');
    return new B2({
        applicationKeyId: requireEnv('APPLICATION_KEY_ID'),
        applicationKey: requireEnv('APPLICATION_KEY')
    });
}

async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}

async function fileExists(filePath) {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function writeJsonLine(stream, value) {
    const line = `${JSON.stringify(value)}\n`;
    if (stream.write(line)) {
        return;
    }

    await new Promise((resolve, reject) => {
        const cleanup = () => {
            stream.off('drain', onDrain);
            stream.off('error', onError);
        };
        const onDrain = () => {
            cleanup();
            resolve();
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };

        stream.once('drain', onDrain);
        stream.once('error', onError);
    });
}

async function writeJsonAtomic(filePath, data) {
    await ensureDir(path.dirname(filePath));
    const tmpPath = `${filePath}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(data));
    await fsp.rename(tmpPath, filePath);
}

async function* readJsonl(filePath) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            const trimmed = line.trim();
            if (trimmed) {
                yield JSON.parse(trimmed);
            }
        }
    } finally {
        rl.close();
    }
}

function thumbKey(filename) {
    return filename.replace(/\//g, '_');
}

function firstFolder(filename) {
    if (!filename || typeof filename !== 'string') {
        return null;
    }
    const index = filename.indexOf('/');
    return index === -1 ? filename : filename.slice(0, index);
}

function encodePath(value) {
    return String(value).split('/').map(encodeURIComponent).join('/');
}

function downloadUrl(apiUrl, bucketName, filename, token) {
    return `${apiUrl}/file/${encodeURIComponent(bucketName)}/${encodePath(filename)}?Authorization=${encodeURIComponent(token)}`;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function truncateMiddle(value, max = 35, head = 20, tail = 10) {
    const str = String(value);
    if (str.length <= max) {
        return str;
    }
    return `${str.slice(0, head)}...${str.slice(str.length - tail)}`;
}

module.exports = {
    ROOT_DIR,
    DIST_DIR,
    THUMBS_DIR,
    INDEX_PATH,
    ALBUMS_PATH,
    LINKS_PATH,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    requireEnv,
    envInt,
    envBool,
    parseExtensions,
    extname,
    isImage,
    isVideo,
    createB2Client,
    ensureDir,
    fileExists,
    writeJsonLine,
    writeJsonAtomic,
    readJsonl,
    thumbKey,
    firstFolder,
    encodePath,
    downloadUrl,
    escapeHtml,
    truncateMiddle
};
