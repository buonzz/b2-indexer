'use strict';

const { escapeHtml, encodePath, truncateMiddle } = require('./common');

const BOOTSTRAP_CSS = '<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH" crossorigin="anonymous">';
const BOOTSTRAP_ICONS = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">';
const BOOTSTRAP_JS = '<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz" crossorigin="anonymous"></script>';

function documentShell(title, body, scripts = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    ${BOOTSTRAP_CSS}
    ${BOOTSTRAP_ICONS}
</head>
<body>
${body}
    ${scripts}
</body>
</html>`;
}

function pagination({ prevHref, nextHref, homeHref, homeLabel = 'Home' }) {
    const items = [];
    if (prevHref) {
        items.push(`<li class="page-item"><a class="page-link" href="${prevHref}">&laquo; Previous</a></li>`);
    }
    if (homeHref) {
        items.push(`<li class="page-item"><a class="page-link" href="${homeHref}">${escapeHtml(homeLabel)}</a></li>`);
    }
    if (nextHref) {
        items.push(`<li class="page-item"><a class="page-link" href="${nextHref}">Next &raquo;</a></li>`);
    }
    return `<nav class="float-end" aria-label="Page navigation">
                    <ul class="pagination">${items.join('')}</ul>
                </nav>`;
}

function galleryCard(item) {
    const label = escapeHtml(truncateMiddle(item.label));
    const thumbnail = escapeHtml(encodePath(item.thumbnail));
    const downloadKey = escapeHtml(item.downloadKey);
    return `<div class="col-sm-6 col-lg-2 mt-2">
                    <div class="card">
                        <img src="${thumbnail}" class="card-img-top" loading="lazy" alt="${label}">
                        <div class="card-body">
                            <p>${label}</p>
                            <a href="#" class="download-btn btn btn-secondary btn-sm" data-filename="${downloadKey}"><i class="bi bi-download"></i></a>
                        </div>
                    </div>
                </div>`;
}

function galleryScripts() {
    return `<script src="https://code.jquery.com/jquery-3.5.1.min.js"></script>
    <script src="https://unpkg.com/masonry-layout@4/dist/masonry.pkgd.min.js"></script>
    <script src="https://unpkg.com/imagesloaded@5/imagesloaded.pkgd.min.js"></script>
    ${BOOTSTRAP_JS}
    <script>
        var downloadLinks = null;
        $.getJSON('download-links.json')
            .done(function (data) { downloadLinks = data; })
            .fail(function () { console.log('Could not load download-links.json'); });
    </script>
    <script src="app.js"></script>`;
}

function renderGalleryPage({
    title,
    heading = '',
    items,
    pageIndex,
    totalPages,
    pageHref,
    homeHref = 'index.html',
    homeLabel = 'Home'
}) {
    const prevHref = pageIndex > 1 ? pageHref(pageIndex - 1) : null;
    const nextHref = pageIndex < totalPages ? pageHref(pageIndex + 1) : null;
    const headingHtml = heading ? `<h5>${escapeHtml(heading)}</h5>` : '';
    const nav = pagination({ prevHref, nextHref, homeHref, homeLabel });

    const body = `    <div class="container mt-2">
        <div class="row">
            <div class="col-md-6">${headingHtml}</div>
            <div class="col-md-6">${nav}</div>
        </div>
    </div>

    <div class="container">
        <div class="row" id="grid">
            ${items.map(galleryCard).join('\n')}
        </div>
    </div>

    <div class="container mt-2">
        <div class="row">
            <div class="col-md-12">${nav}</div>
        </div>
    </div>`;

    return documentShell(title, body, galleryScripts());
}

function renderAlbumIndexPage({ albums, title = 'B2 Indexer Gallery - Albums' }) {
    const cards = albums.map((album) => `<div class="col-sm-6 col-lg-2 mt-2">
                    <div class="card">
                        <div class="card-body">
                            <p>${escapeHtml(truncateMiddle(album.label))}</p>
                            <a href="${escapeHtml(album.link)}" class="btn btn-secondary btn-sm">View</a>
                        </div>
                    </div>
                </div>`).join('\n');

    const body = `    <div class="container mt-2">
        <div class="row">
            <div class="col-md-6"><h5>Albums</h5></div>
        </div>
    </div>

    <div class="container">
        <div class="row" id="grid">
            ${cards}
        </div>
    </div>`;

    return documentShell(title, body, `<script src="https://code.jquery.com/jquery-3.5.1.min.js"></script>
    ${BOOTSTRAP_JS}`);
}

module.exports = {
    renderGalleryPage,
    renderAlbumIndexPage
};
