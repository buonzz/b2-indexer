'use strict';

const {
    INDEX_PATH,
    LINKS_PATH,
    createB2Client,
    readJsonl,
    writeJsonAtomic,
    thumbKey,
    downloadUrl
} = require('./lib/common');

async function run() {
    const b2 = createB2Client();
    const response = await b2.authorize();
    const apiUrl = response.data.apiUrl;
    const bucketName = response.data.allowed.bucketName;
    const authorizationToken = response.data.authorizationToken;

    const links = {};
    let count = 0;

    for await (const entry of readJsonl(INDEX_PATH)) {
        links[thumbKey(entry.filename)] = downloadUrl(
            apiUrl,
            bucketName,
            entry.filename,
            authorizationToken
        );
        count += 1;
    }

    await writeJsonAtomic(LINKS_PATH, links);
    console.log(`Done. Generated ${count} download links.`);
}

run().catch((err) => {
    console.error(err.stack || err);
    process.exitCode = 1;
});
