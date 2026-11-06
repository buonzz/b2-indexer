'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderGalleryPage, renderAlbumIndexPage } = require('../lib/html');

test('renderGalleryPage closes pagination items and escapes content', () => {
    const html = renderGalleryPage({
        title: 'Gallery',
        heading: '<b>Album</b>',
        items: [
            {
                label: '<script>alert(1)</script>',
                thumbnail: 'thumbs/a b.jpg',
                downloadKey: 'a"b.jpg'
            }
        ],
        pageIndex: 1,
        totalPages: 2,
        pageHref: (page) => `page${page}.html`
    });

    assert.equal((html.match(/<li /g) || []).length, (html.match(/<\/li>/g) || []).length);
    assert.match(html, /href="page2.html">Next/);
    assert.match(html, /<h5>&lt;b&gt;Album&lt;\/b&gt;<\/h5>/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /src="thumbs\/a%20b.jpg"/);
    assert.match(html, /data-filename="a&quot;b.jpg"/);
    assert.match(html, /loading="lazy"/);
});

test('renderGalleryPage omits previous link on the first page', () => {
    const html = renderGalleryPage({
        title: 'Gallery',
        items: [],
        pageIndex: 1,
        totalPages: 1,
        pageHref: (page) => `page${page}.html`
    });

    assert.doesNotMatch(html, /Previous/);
    assert.doesNotMatch(html, /Next/);
    assert.match(html, /href="index.html">Home/);
});

test('renderAlbumIndexPage escapes album labels', () => {
    const html = renderAlbumIndexPage({
        albums: [{ label: '<Trip>', link: 'albums-page-1.html' }]
    });

    assert.match(html, /&lt;Trip&gt;/);
    assert.match(html, /href="albums-page-1.html"/);
});
