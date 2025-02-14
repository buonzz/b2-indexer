const B2 = require('backblaze-b2');
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const sharp = require('sharp');

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
        //console.log('Finished reading index.');
        //console.log('Success!');
    });
}

async function onLineRead(line) {
    const jsonLine = JSON.parse(line);
    var extension = path.extname(jsonLine.filename);
    extension = extension.toLowerCase();

    if (!isImage.includes(extension) && !isVideo.includes(extension)) {
        console.log('skipped ' + jsonLine.filename);
        return;
    }

    try {
        let b2_response = await b2.downloadFileById({
            fileId: jsonLine.fileId,
            responseType: 'arraybuffer',
            onDownloadProgress: (event) => { console.log(event) }
        });

        const filePath = tmpFolderPath + jsonLine.filename;
        console.log('processing file ' + jsonLine.filename);

        // scale down image
        if (isImage.includes(extension)) {
            const percentage = 5;
            sharp(b2_response.data).metadata()
                .then(info => {
                    const width = Math.round(info.width * percentage / 100);
                    const height = Math.round(info.height * percentage / 100);
                    return sharp(b2_response.data).resize(width, height).toBuffer();
                })
                .then(output => {
                    fs.writeFileSync(filePath, output);
                });
        }

    } catch (err) {
        console.log(err);
    }
}



run();