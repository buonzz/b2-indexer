'use strict';

const {
    ALBUMS_PATH,
    INDEX_PATH,
    isImage,
    isVideo,
    readJsonl,
    writeJsonAtomic,
    thumbKey,
    firstFolder
} = require('./lib/common');

const NO_ALBUM = 'No Album';

async function run() {
    const albums = Object.create(null);
    let count = 0;

    for await (const entry of readJsonl(INDEX_PATH)) {
        if (!isImage(entry.filename) && !isVideo(entry.filename)) {
            continue;
        }

        const key = firstFolder(entry.filename) || NO_ALBUM;
        const thumbnail = isImage(entry.filename)
            ? `thumbs/${thumbKey(entry.filename)}`
            : `thumbs/${thumbKey(entry.filename)}-thumb.jpg`;

        if (!albums[key]) {
            albums[key] = [];
        }

        albums[key].push({
            filename: entry.filename,
            thumbnail
        });
        count += 1;
    }

    await writeJsonAtomic(ALBUMS_PATH, albums);
    console.log(`Done. Generated ${Object.keys(albums).length} albums from ${count} files.`);
}

run().catch((err) => {
    console.error(err.stack || err);
    process.exitCode = 1;
});
