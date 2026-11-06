'use strict';

const fs = require('fs');
const {
    DIST_DIR,
    INDEX_PATH,
    createB2Client,
    ensureDir,
    requireEnv,
    envInt,
    envBool,
    writeJsonLine
} = require('./lib/common');

const PAGE_SIZE = envInt('B2_PAGE_SIZE', 10000, { min: 1, max: 10000 });
const VERBOSE = envBool('VERBOSE', false);
const EXCLUDE_PATHS = (process.env.EXCLUDE_PATHS || '')
    .split(',')
    .map((prefix) => prefix.trim())
    .filter(Boolean);

function isExcluded(filename) {
    return EXCLUDE_PATHS.some((prefix) => filename.startsWith(prefix));
}

function toIndexEntry(file) {
    return {
        filename: file.fileName,
        contentType: file.contentType,
        contentLength: file.contentLength,
        contentSha1: file.contentSha1,
        fileId: file.fileId,
        uploadTimestamp: file.uploadTimestamp
    };
}

async function run() {
    await ensureDir(DIST_DIR);

    const b2 = createB2Client();
    await b2.authorize();

    const bucketId = requireEnv('BUCKET_ID');
    const stream = fs.createWriteStream(INDEX_PATH, { flags: 'w' });
    const finished = new Promise((resolve, reject) => {
        stream.once('finish', resolve);
        stream.once('error', reject);
    });

    let startFileName = null;
    let page = 0;
    let indexed = 0;
    let skipped = 0;

    try {
        do {
            const params = { bucketId, maxFileCount: PAGE_SIZE };
            if (startFileName) {
                params.startFileName = startFileName;
            }

            const response = await b2.listFileNames(params);
            page += 1;

            for (const file of response.data.files) {
                const entry = toIndexEntry(file);

                if (isExcluded(entry.filename)) {
                    skipped += 1;
                    if (VERBOSE) {
                        console.log(`skipped (excluded): ${entry.filename}`);
                    }
                    continue;
                }

                await writeJsonLine(stream, entry);
                indexed += 1;
                if (VERBOSE) {
                    console.log(`indexed: ${entry.filename}`);
                }
            }

            startFileName = response.data.nextFileName || null;
            console.log(`page ${page}: ${indexed} indexed, ${skipped} skipped`);
        } while (startFileName);
    } finally {
        stream.end();
        await finished;
    }

    console.log(`Done. Indexed ${indexed} files (${skipped} skipped).`);
}

run().catch((err) => {
    console.error(err.stack || err);
    process.exitCode = 1;
});
