'use strict';

const fsp = require('fs/promises');
const path = require('path');
const {
    DIST_DIR,
    THUMBS_DIR,
    IMAGE_EXTENSIONS,
    ensureDir,
    envInt,
    extname
} = require('./lib/common');
const { renderGalleryPage } = require('./lib/html');

const IMAGES_PER_PAGE = envInt('SITE_IMAGES_PER_PAGE', 50, { min: 1 });

async function run() {
    await ensureDir(DIST_DIR);

    const files = (await fsp.readdir(THUMBS_DIR))
        .filter((file) => IMAGE_EXTENSIONS.has(extname(file)))
        .sort();

    const totalPages = Math.max(1, Math.ceil(files.length / IMAGES_PER_PAGE));

    for (let pageIndex = 1; pageIndex <= totalPages; pageIndex += 1) {
        const start = (pageIndex - 1) * IMAGES_PER_PAGE;
        const items = files.slice(start, start + IMAGES_PER_PAGE).map((file) => ({
            label: file,
            thumbnail: `thumbs/${file}`,
            downloadKey: file
        }));

        const html = renderGalleryPage({
            title: `B2 Indexer Gallery - Page ${pageIndex}`,
            items,
            pageIndex,
            totalPages,
            pageHref: (page) => `page${page}.html`,
            homeHref: 'index.html',
            homeLabel: 'Albums'
        });

        await fsp.writeFile(path.join(DIST_DIR, `page${pageIndex}.html`), html);

        if (pageIndex === 1) {
            await fsp.writeFile(path.join(DIST_DIR, 'all-index.html'), html);
        }
    }

    console.log(`Done. Generated ${totalPages} pages in ${DIST_DIR}.`);
}

run().catch((err) => {
    console.error(err.stack || err);
    process.exitCode = 1;
});
