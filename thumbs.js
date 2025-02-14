const B2 = require('backblaze-b2');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

require('dotenv').config()

const b2 = new B2({
    applicationKeyId: process.env.APPLICATION_KEY_ID, // or accountId: 'accountId'
    applicationKey: process.env.APPLICATION_KEY // or masterApplicationKey
});

const folderPath = path.join(__dirname, 'dist/thumbs/' + process.env.BUCKET_ID + '/');
const tmpFolderPath = path.join(__dirname, 'tmp/');
const indexPath = path.join(__dirname, 'dist/' + process.env.BUCKET_ID + '-index.jsonl');

const isImage = ['.jpg', '.jpeg', '.png']; //you can add more
const isVideo = ['.mov', '.mp4']; // you can add more extension


async function run() {

    const fileStream = fs.createReadStream(indexPath);

    try {
        await b2.authorize();
    } catch (err) {
        console.log('Error authorizing bucket');
    }

    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    rl.on('line', onLineRead);

    rl.on('close', () => {
        console.log('Finished reading index.');
        console.log('Success!');
    });
}

async function onLineRead(line) {
    const jsonLine = JSON.parse(line);
    var extension = path.extname(jsonLine.filename);

    if (!isImage.includes(extension) && !isVideo.includes(extension)) {
        console.log('skipped ' + jsonLine.filename);
        return;
    }

    try {
        let b2_response = await b2.downloadFileById({
            fileId: jsonLine.fileId,
            responseType: 'arraybuffer'
        });

        const filePath = tmpFolderPath + jsonLine.filename;

        fs.writeFileSync(filePath, Buffer.from(b2_response.data));
        console.log('downloading ' + jsonLine.filename);
    } catch (err) {
        console.log(err);
    }
}



run();