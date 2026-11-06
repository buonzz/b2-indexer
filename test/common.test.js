'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
    parseExtensions,
    thumbKey,
    firstFolder,
    encodePath,
    downloadUrl,
    escapeHtml,
    truncateMiddle,
    writeJsonAtomic,
    readJsonl
} = require('../lib/common');

test('parseExtensions normalizes entries', () => {
    assert.deepEqual(parseExtensions('jpg, .PNG ,,  webp'), ['.jpg', '.png', '.webp']);
    assert.deepEqual(parseExtensions(''), []);
});

test('thumbKey flattens folders', () => {
    assert.equal(thumbKey('2024/Trip/photo.jpg'), '2024_Trip_photo.jpg');
    assert.equal(thumbKey('photo.jpg'), 'photo.jpg');
});

test('firstFolder returns the top-level segment', () => {
    assert.equal(firstFolder('2024/Trip/photo.jpg'), '2024');
    assert.equal(firstFolder('photo.jpg'), 'photo.jpg');
    assert.equal(firstFolder(''), null);
    assert.equal(firstFolder(null), null);
});

test('encodePath encodes each segment but keeps slashes', () => {
    assert.equal(encodePath('a b/c#d.jpg'), 'a%20b/c%23d.jpg');
});

test('downloadUrl builds an authorized B2 URL', () => {
    assert.equal(
        downloadUrl('https://api.example', 'my bucket', 'a b/c.jpg', 'token'),
        'https://api.example/file/my%20bucket/a%20b/c.jpg?Authorization=token'
    );
});

test('escapeHtml escapes markup characters', () => {
    assert.equal(
        escapeHtml(`<img src="x" onerror='alert(1)'>`),
        '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;'
    );
});

test('truncateMiddle keeps short strings and trims long ones', () => {
    assert.equal(truncateMiddle('short'), 'short');
    const result = truncateMiddle('a'.repeat(40) + 'b'.repeat(10));
    assert.equal(result.length, 33);
    assert.ok(result.includes('...'));
});

test('writeJsonAtomic and readJsonl round-trip', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'b2-indexer-'));
    const jsonPath = path.join(dir, 'data.json');
    const jsonlPath = path.join(dir, 'data.jsonl');

    await writeJsonAtomic(jsonPath, { hello: 'world' });
    assert.deepEqual(JSON.parse(await fs.readFile(jsonPath, 'utf8')), { hello: 'world' });

    await fs.writeFile(jsonlPath, '{"a":1}\n\n{"a":2}\n');

    const rows = [];
    for await (const row of readJsonl(jsonlPath)) {
        rows.push(row);
    }
    assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);

    await fs.rm(dir, { recursive: true, force: true });
});
