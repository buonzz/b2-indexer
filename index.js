const B2 = require('backblaze-b2');
const fs = require('fs');
const path = require('path');

require('dotenv').config()

const b2 = new B2({
    applicationKeyId: process.env.APPLICATION_KEY_ID, // or accountId: 'accountId'
    applicationKey: process.env.APPLICATION_KEY // or masterApplicationKey
});

const filePath = path.join(__dirname, 'dist/output.jsonl');


async function run() {
    try {
        await b2.authorize();
    } catch (err) {
        console.log('Error authorizing bucket');
    }

    var listFilesParams = {
        bucketId: process.env.BUCKET_ID,
        delimiter: ''
    }

    listFilesParams.maxFileCount = 100;

    const filenames = await b2.listFileNames(listFilesParams);


    let data = filenames.data.files.map(function (cur) {
        return {
            filename: cur.fileName,
            contentType: cur.contentType,
            contentLength: cur.contentLength,
            contentSha1: cur.contentSha1,
            fileId: cur.fileId,
            uploadTimestamp: cur.uploadTimestamp
        }
    });

    const stream = fs.createWriteStream(filePath, { flags: 'w' });
    for (i = 0; i < data.length; i++) {
        stream.write(JSON.stringify(data[i]) + "\n");
    }
    stream.end();

    console.log('Success!');
}

run();