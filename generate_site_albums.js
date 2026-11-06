'use strict';

const fsp = require('fs/promises');
const path = require('path');
const {
    DIST_DIR,
    ALBUMS_PATH,
    ensureDir,
    thumbKey
} = require('./lib/common');
const { renderGalleryPage, renderAlbumIndexPage } = require('./lib/html');

async function run() {
    await ensureDir(DIST_DIR);

    const albums = JSON.parse(await fsp.readFile(ALBUMS_PATH, 'utf8'));
    const albumNames = Object.keys(albums);
    const totalPages = albumNames.length;
    const albumLinks = [];

    for (let pageIndex = 1; pageIndex <= totalPages; pageIndex += 1) {
        const album = albumNames[pageIndex - 1];
        const items = albums[album].map((image) => ({
            label: image.filename,
            thumbnail: image.thumbnail,
            downloadKey: thumbKey(image.filename)
        }));

        const html = renderGalleryPage({
            title: `B2 Indexer Gallery - ${album} - Page ${pageIndex}`,
            heading: album,
            items,
            pageIndex,
            totalPages,
            pageHref: (page) => `albums-page-${page}.html`,
            homeHref: 'index.html',
            homeLabel: 'Home'
        });

        await fsp.writeFile(
            path.join(DIST_DIR, `albums-page-${pageIndex}.html`),
            html
        );

        albumLinks.push({
            label: album,
            link: `albums-page-${pageIndex}.html`
        });
    }

    albumLinks.push({ label: 'All', link: 'all-index.html' });

    await fsp.writeFile(
        path.join(DIST_DIR, 'index.html'),
        renderAlbumIndexPage({ albums: albumLinks })
    );

    console.log(`Done. Generated ${totalPages} album pages in ${DIST_DIR}.`);
}

run().catch((err) => {
    console.error(err.stack || err);
    process.exitCode = 1;
});
