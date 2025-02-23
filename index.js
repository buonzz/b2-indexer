const B2 = require('backblaze-b2');
const fs = require('fs');
const path = require('path');

require('dotenv').config()

const b2 = new B2({
    applicationKeyId: process.env.APPLICATION_KEY_ID, // or accountId: 'accountId'
    applicationKey: process.env.APPLICATION_KEY // or masterApplicationKey
});

const filePath = path.join(__dirname, 'dist/' + process.env.BUCKET_ID + '-index.jsonl');


async function run() {

    const stream = fs.createWriteStream(filePath, { flags: 'w' });

    try {
        await b2.authorize();
    } catch (err) {
        console.log('Error authorizing bucket');
    }

    var listFilesParams = {
        bucketId: process.env.BUCKET_ID,
        delimiter: ''
    }
    listFilesParams.maxFileCount = 1000;
    var startFileName = null;
    var ctr = 1;
    while (true) {
        if (startFileName != null) {
            listFilesParams.startFileName = startFileName;
        }

        startFileName = await processPage(b2, stream, listFilesParams);
        //console.log('startFileName=' + startFileName);
        if (startFileName == null) {
            break;
        }
        console.log('page: ' + ctr);
        console.log('files indexed: ' + ctr * 1000);
        ctr++;
    }


    stream.end();

    console.log('Estimated files indexed: ' + ctr * 1000);
    console.log('Success!');
}

async function processPage(b2, stream, params) {
    const filenames = await b2.listFileNames(params);
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

    main_loop:
    for (i = 0; i < data.length; i++) {

        if (process.env.EXCLUDE_PATHS) {
            var excludePaths = process.env.EXCLUDE_PATHS.split(",");
            if (excludePaths.length > 0) {
                for (j = 0; j < excludePaths.length; j++) {
                    if (data[i].filename.startsWith(excludePaths[j])) {
                        console.log('skipped due to  excluded folder: ' + data[i].filename);
                        break main_loop;
                    }
                }
            }
        }

        stream.write(JSON.stringify(data[i]) + "\n");
        console.log('indexed ' + data[i].filename);
    }

    return filenames.data.nextFileName;
}

run();