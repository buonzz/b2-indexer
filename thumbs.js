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
const tmpFolderPath = path.join(__dirname, 'tmp/' + process.env.BUCKET_ID + '/');
const indexPath = path.join(__dirname, 'dist/' + process.env.BUCKET_ID + '-index.jsonl');


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

    let b2_response = await b2.downloadFileById({
        fileId: jsonLine.file_id,
        responseType: 'arraybuffer'
    });

    const filePath = tmpFolderPath + jsonLine.filename;

    fs.writeFileSync(filePath, Buffer.from(myArrayBuffer));

    console.log(jsonLine);
}



run();